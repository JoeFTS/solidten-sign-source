import { prisma } from '@documenso/prisma';
import { EnvelopeType, type Prisma } from '@prisma/client';

import { IS_PUBLIC_FORMS_ENABLED } from '../../constants/public-forms';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { isTspEnvelope } from '../../types/signature-level';
import { getPublicFormAvailability, getUnverifiedFormBlocker } from '../../utils/public-form';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertNoFileFieldsForDirectTemplate } from '../field-file/assert-file-fields';

type FormEnvelope = { internalVersion: number; signatureLevel: string };

export const isPublicFormSupported = (envelope: FormEnvelope) =>
  envelope.internalVersion === 2 && !isTspEnvelope(envelope);

/**
 * Every new direct link on a version 2 template is a public form with the safe defaults:
 * verified email on, no dates, no cap. Other templates keep the plain direct link.
 */
export const createPublicFormForDirectLink = async ({
  tx,
  envelope,
  directLinkId,
}: {
  tx: Prisma.TransactionClient;
  envelope: FormEnvelope;
  directLinkId: string;
}) => {
  if (!isPublicFormSupported(envelope)) {
    return;
  }

  await tx.stPublicForm.create({
    data: {
      directLinkId,
    },
  });
};

const getTemplateForForm = async ({
  userId,
  teamId,
  envelopeId,
}: {
  userId: number;
  teamId: number;
  envelopeId: string;
}) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    type: EnvelopeType.TEMPLATE,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: {
      id: true,
      title: true,
      internalVersion: true,
      signatureLevel: true,
      recipients: { select: { id: true } },
      documentMeta: { select: { allowDictateNextSigner: true } },
      directLink: {
        include: {
          stPublicForm: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Template not found' });
  }

  return envelope;
};

type TemplateForForm = Awaited<ReturnType<typeof getTemplateForForm>>;

const getBlocker = (envelope: TemplateForForm) =>
  envelope.directLink
    ? getUnverifiedFormBlocker({
        recipientIds: envelope.recipients.map((recipient) => recipient.id),
        directRecipientId: envelope.directLink.directTemplateRecipientId,
        allowDictateNextSigner: envelope.documentMeta?.allowDictateNextSigner ?? false,
      })
    : null;

const assertFormTemplate = (envelope: TemplateForForm) => {
  if (!envelope.directLink) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'This template has no direct link.' });
  }

  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Public forms need a version 2 template.' });
  }

  if (isTspEnvelope(envelope)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Public forms cannot be used with advanced or qualified signatures.',
    });
  }

  return envelope.directLink;
};

export const getPublicFormSettings = async (options: { userId: number; teamId: number; envelopeId: string }) => {
  const envelope = await getTemplateForForm(options);

  const form = envelope.directLink?.stPublicForm ?? null;

  return {
    isSupported: Boolean(envelope.directLink) && isPublicFormSupported(envelope),
    isEditable: IS_PUBLIC_FORMS_ENABLED(),
    // Solid Ten Sign (S-M6): without Turnstile, public forms rely on rate limits and caps only.
    isCaptchaConfigured: Boolean(
      process.env.NEXT_PRIVATE_TURNSTILE_SECRET_KEY && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    ),
    unverifiedBlocker: getBlocker(envelope),
    form: form
      ? {
          ...form,
          availability: getPublicFormAvailability(form, new Date()),
        }
      : null,
  };
};

export type UpdatePublicFormSettingsData = {
  opensAt: Date | null;
  closesAt: Date | null;
  maxSubmissions: number | null;
  introText: string | null;
  thankYouMessage: string | null;
  redirectUrl: string | null;
  requireVerifiedEmail: boolean;
};

export const updatePublicFormSettings = async ({
  data,
  ...options
}: {
  userId: number;
  teamId: number;
  envelopeId: string;
  data: UpdatePublicFormSettingsData;
}) => {
  if (!IS_PUBLIC_FORMS_ENABLED()) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Public form settings are turned off on this server.',
    });
  }

  const envelope = await getTemplateForForm(options);
  const directLink = assertFormTemplate(envelope);

  // Solid Ten: a public form cannot take file uploads yet.
  assertNoFileFieldsForDirectTemplate(
    await prisma.field.findMany({ where: { envelopeId: envelope.id }, select: { type: true, fieldMeta: true } }),
  );

  if (data.opensAt && data.closesAt && data.opensAt.getTime() >= data.closesAt.getTime()) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'The close date must be after the open date.' });
  }

  if (!data.requireVerifiedEmail) {
    const blocker = getBlocker(envelope);

    if (blocker === 'OTHER_RECIPIENTS') {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message:
          'This template sends email to other recipients, so the form must verify the email address of the person who fills it in.',
      });
    }

    if (blocker === 'NEXT_SIGNER_DICTATION') {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message:
          'This template lets the person who fills it in choose the next signer, so the form must verify their email address.',
      });
    }
  }

  const values = {
    opensAt: data.opensAt,
    closesAt: data.closesAt,
    maxSubmissions: data.maxSubmissions,
    introText: data.introText?.trim() || null,
    thankYouMessage: data.thankYouMessage?.trim() || null,
    redirectUrl: data.redirectUrl?.trim() || null,
    requireVerifiedEmail: data.requireVerifiedEmail,
  };

  return await prisma.stPublicForm.upsert({
    where: { directLinkId: directLink.id },
    create: { directLinkId: directLink.id, ...values },
    update: values,
  });
};

/**
 * The "close form" button. Allowed even when settings are turned off, because it only
 * makes a form safer.
 */
export const setPublicFormClosed = async ({
  closed,
  ...options
}: {
  userId: number;
  teamId: number;
  envelopeId: string;
  closed: boolean;
}) => {
  const envelope = await getTemplateForForm(options);
  const directLink = assertFormTemplate(envelope);

  const closedAt = closed ? new Date() : null;

  return await prisma.stPublicForm.upsert({
    where: { directLinkId: directLink.id },
    create: { directLinkId: directLink.id, closedAt },
    update: { closedAt },
  });
};

export const getPublicFormIdForTemplate = async (options: { userId: number; teamId: number; envelopeId: string }) => {
  const envelope = await getTemplateForForm(options);

  return { envelope, formId: envelope.directLink?.stPublicForm?.id ?? null };
};
