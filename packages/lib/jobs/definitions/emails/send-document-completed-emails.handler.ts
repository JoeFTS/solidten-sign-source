import { DocumentCompletedEmailTemplate } from '@documenso/email/templates/document-completed';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { DocumentSource, EnvelopeType, RecipientRole } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import {
  getDocumentDeliveryForBytes,
  sendWithDocumentDeliveryFallback,
  type TDocumentDelivery,
} from '../../../server-only/email/document-email-attachments';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { getStoredDocumentBytes } from '../../../server-only/email/stored-document-size';
import { getInPersonCompletionEmailRecipientIds } from '../../../server-only/in-person/in-person-completion-email';
import { assertOrganisationRatesAndLimits } from '../../../server-only/rate-limit/assert-organisation-rates-and-limits';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import { canSendMailToRecipient } from '../../../utils/recipient-mail';
import { renderCustomEmailTemplate } from '../../../utils/render-custom-email-template';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import { formatDocumentsPath } from '../../../utils/teams';
import type { JobRunIO } from '../../client/_internal/job';
import { recordEmailStoppedByLimit } from '../solidten/email-limit-drop';
import type { TSendDocumentCompletedEmailsJobDefinition } from './send-document-completed-emails';

export const run = async ({ payload, io }: { payload: TSendDocumentCompletedEmailsJobDefinition; io: JobRunIO }) => {
  const { envelopeId, requestMetadata, resend } = payload;

  const envelope = await prisma.envelope.findUnique({
    where: unsafeBuildEnvelopeIdQuery({ type: 'envelopeId', id: envelopeId }, EnvelopeType.DOCUMENT),
    include: {
      envelopeItems: {
        include: {
          // Solid Ten: not `data`; the files are loaded only when they will be attached (LD2-B).
          documentData: {
            select: {
              type: true,
              id: true,
            },
          },
        },
      },
      documentMeta: true,
      recipients: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          disabled: true,
        },
      },
      team: {
        select: {
          id: true,
          url: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  const isDirectTemplate = envelope?.source === DocumentSource.TEMPLATE_DIRECT_LINK;

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  const { branding, emailLanguage, senderEmail, replyToEmail, organisationId, claims, emailsDisabled, emailTransport } =
    await getEmailContext({
      emailType: 'RECIPIENT',
      source: {
        type: 'team',
        teamId: envelope.teamId,
      },
      meta: envelope.documentMeta,
    });

  // Don't send completion emails if the organisation has email sending disabled or the owner is disabled (e.g. banned).
  if (envelope.user.disabled || emailsDisabled) {
    return;
  }

  const { user: owner } = envelope;

  // Solid Ten: decide from the stored size before loading anything, so a large document (also
  // in a job queued before this change) never sits in memory to be attached (LD2-B).
  const plannedDelivery = getDocumentDeliveryForBytes(
    await getStoredDocumentBytes(envelope.envelopeItems.map((envelopeItem) => envelopeItem.documentData.id)),
  );

  let loadedAttachments: Array<{ filename: string; content: Buffer; contentType: string }> | null = null;

  const loadAttachments = async () => {
    loadedAttachments ??= await loadCompletedDocumentAttachments();

    return loadedAttachments;
  };

  const loadCompletedDocumentAttachments = async () =>
    await Promise.all(
      envelope.envelopeItems.map(async (envelopeItem) => {
        const { data } = await prisma.documentData.findUniqueOrThrow({
          where: { id: envelopeItem.documentData.id },
          select: { data: true },
        });

        const file = await getFileServerSide({ type: envelopeItem.documentData.type, data });

        // Use the envelope title for version 1, and the envelope item title for version 2.
        const fileNameToUse = envelope.internalVersion === 1 ? envelope.title : envelopeItem.title;

        return {
          filename: fileNameToUse.endsWith('.pdf') ? fileNameToUse : fileNameToUse + '.pdf',
          content: Buffer.from(file),
          contentType: 'application/pdf',
        };
      }),
    );

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  let documentOwnerDownloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(
    envelope.team?.url,
  )}/${envelope.id}`;

  if (envelope.team?.url) {
    documentOwnerDownloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}/t/${envelope.team.url}/documents/${envelope.id}`;
  }

  const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);
  const isDocumentCompletedEmailEnabled = emailSettings.documentCompleted;
  const isOwnerDocumentCompletedEmailEnabled = emailSettings.ownerDocumentCompleted;

  // Send email to document owner if:
  // 1. Owner document completed emails are enabled AND
  // 2. Either:
  //    - The owner is not a recipient, OR
  //    - Recipient emails are disabled
  const isOwnerCopyIntended =
    !resend &&
    isOwnerDocumentCompletedEmailEnabled &&
    (!envelope.recipients.find((recipient) => recipient.email === owner.email) || !isDocumentCompletedEmailEnabled);

  // Solid Ten (F4-M1): every copy is its own task and is sent on its own; one that fails does not
  // stop or hide the others (sends below, Promise.allSettled).
  const copySends: Array<() => Promise<unknown>> = [];

  if (isOwnerCopyIntended) {
    const renderOwnerEmail = async (delivery: TDocumentDelivery) => {
      const template = createElement(DocumentCompletedEmailTemplate, {
        documentName: envelope.title,
        assetBaseUrl,
        downloadLink: documentOwnerDownloadLink,
        isDocumentAttached: delivery === 'ATTACHMENT',
      });

      return await Promise.all([
        renderEmailWithI18N(template, { lang: emailLanguage, branding }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);
    };

    const i18n = await getI18nInstance(emailLanguage);

    // Solid Ten: one task per email, so a re-run (retry or recovery) sends only what is missing.
    copySends.push(
      async () =>
        await io.runTask('send-owner-completed-email', async () => {
          // Solid Ten: attached when the files fit the mail limit, else a download link.
          const documentDelivery = await sendWithDocumentDeliveryFallback(plannedDelivery, async (delivery) => {
            const [html, text] = await renderOwnerEmail(delivery);

            await emailTransport.sendMail({
              to: [
                {
                  name: owner.name || '',
                  address: owner.email,
                },
              ],
              from: senderEmail,
              replyTo: replyToEmail,
              subject: i18n._(msg`Signing Complete!`),
              html,
              text,
              attachments: delivery === 'ATTACHMENT' ? await loadAttachments() : undefined,
            });
          });

          await prisma.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
              envelopeId: envelope.id,
              user: null,
              requestMetadata,
              data: {
                emailType: 'DOCUMENT_COMPLETED',
                recipientEmail: owner.email,
                recipientName: owner.name ?? '',
                recipientId: owner.id,
                recipientRole: 'OWNER',
                isResending: false,
                documentDelivery,
              },
            }),
          });
        }),
    );
  }

  // Solid Ten Sign: signers hosted in person get their copy even when no signing emails were sent.
  const inPersonRecipientIds = await getInPersonCompletionEmailRecipientIds({ envelope });

  const recipientsToNotify =
    !isDocumentCompletedEmailEnabled && inPersonRecipientIds.length === 0
      ? []
      : envelope.recipients.filter(
          (recipient) =>
            canSendMailToRecipient(recipient) &&
            (isDocumentCompletedEmailEnabled || inPersonRecipientIds.includes(recipient.id)) &&
            (!resend || recipient.id === resend.recipientId),
        );

  // Solid Ten Sign: a resend is recorded with the person who asked for it.
  const resendUser = resend
    ? await prisma.user.findUnique({ where: { id: resend.userId }, select: { id: true, email: true, name: true } })
    : null;

  // Solid Ten (F4-M1): the copies this job is to deliver, kept from its first run, so a job that is
  // given up reports every copy that was not sent (completed-email-delivery.ts), also those whose
  // send never started.
  await io.runTask('completed-email-plan', async () => ({
    isOwnerCopyIntended,
    recipientIds: recipientsToNotify.map((recipient) => recipient.id),
  }));

  copySends.push(
    ...recipientsToNotify.map((recipient) => async () => {
      // A CC recipient never asked to be part of this document, so their completion
      // email is effectively unsolicited. Meter it against the organisation email
      // quota/stats so it is correctly logged.
      // A resend was metered when it was asked for (resend-completed-copy.ts).
      if (recipient.role === RecipientRole.CC && !resend) {
        try {
          await assertOrganisationRatesAndLimits({
            organisationId,
            organisationClaim: claims,
            type: 'email',
            count: 1,
          });
        } catch (_err) {
          io.logger.warn({
            msg: 'CC completion email dropped: org email limit exceeded',
            organisationId,
            recipientId: recipient.id,
            envelopeId: envelope.id,
          });

          // Solid Ten Sign (N-6): not silent: the "Copy not delivered" mark and an audit entry.
          await recordEmailStoppedByLimit({ envelopeId: envelope.id, recipient, emailType: 'DOCUMENT_COMPLETED' });

          // On rate/quota exceeded, early return to allow other recipients to be processed.
          return;
        }
      }

      const customEmailTemplate = {
        'signer.name': recipient.name,
        'signer.email': recipient.email,
        'document.name': envelope.title,
      };

      const downloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}/complete`;
      const reportUrl =
        recipient.role === RecipientRole.CC ? `${NEXT_PUBLIC_WEBAPP_URL()}/report/${recipient.token}` : undefined;

      const renderRecipientEmail = async (delivery: TDocumentDelivery) => {
        const template = createElement(DocumentCompletedEmailTemplate, {
          documentName: envelope.title,
          assetBaseUrl,
          downloadLink: recipient.email === owner.email ? documentOwnerDownloadLink : downloadLink,
          customBody:
            isDirectTemplate && envelope.documentMeta?.message
              ? renderCustomEmailTemplate(envelope.documentMeta.message, customEmailTemplate)
              : undefined,
          reportUrl,
          isDocumentAttached: delivery === 'ATTACHMENT',
        });

        return await Promise.all([
          renderEmailWithI18N(template, { lang: emailLanguage, branding }),
          renderEmailWithI18N(template, {
            lang: emailLanguage,
            branding,
            plainText: true,
          }),
        ]);
      };

      const i18n = await getI18nInstance(emailLanguage);

      await io.runTask(`send-completed-email-${recipient.id}`, async () => {
        // Solid Ten: attached when the files fit the mail limit, else a download link.
        const documentDelivery = await sendWithDocumentDeliveryFallback(plannedDelivery, async (delivery) => {
          const [html, text] = await renderRecipientEmail(delivery);

          await emailTransport.sendMail({
            to: [
              {
                name: recipient.name,
                address: recipient.email,
              },
            ],
            from: senderEmail,
            replyTo: replyToEmail,
            subject:
              isDirectTemplate && envelope.documentMeta?.subject
                ? renderCustomEmailTemplate(envelope.documentMeta.subject, customEmailTemplate)
                : i18n._(msg`Signing Complete!`),
            html,
            text,
            attachments: delivery === 'ATTACHMENT' ? await loadAttachments() : undefined,
          });
        });

        await prisma.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
            envelopeId: envelope.id,
            user: resendUser,
            requestMetadata,
            data: {
              emailType: 'DOCUMENT_COMPLETED',
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientId: recipient.id,
              recipientRole: recipient.role,
              isResending: Boolean(resend),
              documentDelivery,
            },
          }),
        });

        // Solid Ten Sign: the mail server accepted the resent copy, so it is no longer "not delivered".
        if (resend) {
          await prisma.recipient.update({ where: { id: recipient.id }, data: { deliveryFailedAt: null } });
        }
      });
    }),
  );

  // Every copy is tried; a copy that failed fails the attempt (after the others were sent), so
  // the retry sends only what is still missing.
  const results = await Promise.allSettled(copySends.map(async (send) => await send()));
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

  if (failed.length > 0) {
    io.logger.warn(`${failed.length} of ${results.length} completion email(s) not sent this attempt`);

    throw failed[0].reason;
  }
};
