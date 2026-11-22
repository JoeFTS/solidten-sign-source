import { prisma } from '@documenso/prisma';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { DOCUMENSO_ENCRYPTION_KEY } from '../../constants/crypto';
import { AppError } from '../../errors/app-error';
import { getPublicFormAvailability } from '../../utils/public-form';

/**
 * The enabled direct link behind a public form token, with its form settings. `form` is null
 * for a link that is not a public form (version 1 templates, and links made before forms).
 */
export const findPublicFormByToken = async (token: string) => {
  const directLink = await prisma.templateDirectLink.findFirst({
    where: {
      token,
      enabled: true,
      envelope: {
        type: EnvelopeType.TEMPLATE,
        status: DocumentStatus.DRAFT,
      },
    },
    include: {
      stPublicForm: true,
      envelope: {
        select: {
          id: true,
          title: true,
          teamId: true,
          userId: true,
          recipients: { select: { id: true } },
          documentMeta: true,
        },
      },
    },
  });

  if (!directLink) {
    return null;
  }

  return { directLink, envelope: directLink.envelope, form: directLink.stPublicForm };
};

export const getPublicFormKey = () => {
  if (!DOCUMENSO_ENCRYPTION_KEY) {
    throw new Error('Missing DOCUMENSO_ENCRYPTION_KEY');
  }

  return DOCUMENSO_ENCRYPTION_KEY;
};

/**
 * Rate limit rows are stored in plain text, so an email address is only ever used hashed.
 */
export const getFormEmailIdentifier = (formId: string, email: string) =>
  `${formId}:${bytesToHex(sha256(email.toLowerCase())).slice(0, 32)}`;

export const assertPublicFormOpen = (form: Parameters<typeof getPublicFormAvailability>[0]) => {
  const availability = getPublicFormAvailability(form, new Date());

  if (availability === 'NOT_OPEN_YET') {
    throw new AppError('PUBLIC_FORM_NOT_OPEN', { message: 'This form is not open yet.', statusCode: 400 });
  }

  if (availability === 'CLOSED') {
    throw new AppError('PUBLIC_FORM_CLOSED', { message: 'This form is closed.', statusCode: 400 });
  }

  if (availability === 'FULL') {
    throw new AppError('PUBLIC_FORM_FULL', {
      message: 'This form has reached its maximum number of responses.',
      statusCode: 400,
    });
  }
};
