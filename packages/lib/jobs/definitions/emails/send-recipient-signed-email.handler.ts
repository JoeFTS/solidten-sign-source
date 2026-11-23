import { DocumentRecipientSignedEmailTemplate } from '@documenso/email/templates/document-recipient-signed';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { EnvelopeType } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { canOwnerReachTeam } from '../../../server-only/team/reassign-envelopes-after-access-loss';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import { isRecipientEmailValidForSending } from '../../../utils/recipients';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import { runTaskAtMostOnce } from '../../client/at-most-once-task';
import type { TSendRecipientSignedEmailJobDefinition } from './send-recipient-signed-email';

export const run = async ({ payload, io }: { payload: TSendRecipientSignedEmailJobDefinition; io: JobRunIO }) => {
  const { documentId, recipientId } = payload;

  const envelope = await prisma.envelope.findFirst({
    where: {
      ...unsafeBuildEnvelopeIdQuery(
        {
          type: 'documentId',
          id: documentId,
        },
        EnvelopeType.DOCUMENT,
      ),
      recipients: {
        some: {
          id: recipientId,
        },
      },
    },
    include: {
      recipients: {
        where: {
          id: recipientId,
        },
      },
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
      documentMeta: true,
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  const isRecipientSignedEmailEnabled = extractDerivedDocumentEmailSettings(envelope.documentMeta).recipientSigned;

  if (!isRecipientSignedEmailEnabled) {
    return;
  }

  const [recipient] = envelope.recipients;
  const { email: recipientEmail, name: recipientName } = recipient;
  const { user: owner } = envelope;

  // Solid Ten: an owner who lost access to the team gets no more notices of its documents.
  if (!(await canOwnerReachTeam({ userId: owner.id, teamId: envelope.teamId }))) {
    return;
  }

  const recipientReference = recipientName || recipientEmail;

  // Don't send notification if the owner is the one who signed.
  if (owner.email === recipientEmail || !isRecipientEmailValidForSending(recipient)) {
    return;
  }

  const { branding, emailLanguage, senderEmail, emailTransport, emailsDisabled } = await getEmailContext({
    emailType: 'INTERNAL',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  // Solid Ten Sign (F-1): the organisation's "email off" applies, as for the other document mails.
  if (emailsDisabled) {
    return;
  }

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  const i18n = await getI18nInstance(emailLanguage);

  const template = createElement(DocumentRecipientSignedEmailTemplate, {
    documentName: envelope.title,
    recipientName,
    recipientEmail,
    assetBaseUrl,
  });

  // Solid Ten: at most once; a re-run after a crash during the send does not send it twice.
  await runTaskAtMostOnce(io, 'send-recipient-signed-email', async (markSending) => {
    const [html, text] = await Promise.all([
      renderEmailWithI18N(template, { lang: emailLanguage, branding }),
      renderEmailWithI18N(template, {
        lang: emailLanguage,
        branding,
        plainText: true,
      }),
    ]);

    await markSending();

    await emailTransport.sendMail({
      to: {
        name: owner.name ?? '',
        address: owner.email,
      },
      from: senderEmail,
      subject: i18n._(msg`${recipientReference} has signed "${envelope.title}"`),
      html,
      text,
    });
  });
};
