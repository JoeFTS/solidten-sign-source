import { SolidTenNoticeTemplate } from '@documenso/email/templates/solidten-notice';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { createElement } from 'react';
import { match } from 'ts-pattern';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { withoutServiceAccounts } from '../../../server-only/email/deliverable-recipients';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import {
  notifyOperatorsOfSealFailed,
  sealFailedNoticeText,
} from '../../../server-only/jobs/seal-failed-operator-notice';
import { canOwnerReachTeam } from '../../../server-only/team/reassign-envelopes-after-access-loss';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { getRecipientCommentThreadKey, SHARED_COMMENT_THREAD_KEY } from '../../../utils/envelope-comments';
import { isRecipientEmailValidForSending } from '../../../utils/recipients';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import { formatDocumentsPath } from '../../../utils/teams';
import type { JobRunIO } from '../../client/_internal/job';
import { runTaskAtMostOnce } from '../../client/at-most-once-task';
import type { TSendSolidTenNoticeEmailJobDefinition } from './send-solidten-notice-email';

/** Comment text in an email, shown as text, cut to a readable length. */
const truncateCommentForEmail = (body: string) => (body.length > 500 ? `${body.slice(0, 500)}…` : body);

type Notice = {
  to: { name: string; address: string }[];
  subject: string;
  heading: string;
  paragraphs: string[];
  actionLabel?: string;
  actionLink?: string;
};

export const run = async ({ payload, io }: { payload: TSendSolidTenNoticeEmailJobDefinition; io: JobRunIO }) => {
  const envelope = await prisma.envelope.findFirst({
    where: { id: payload.envelopeId },
    include: {
      user: { select: { id: true, email: true, name: true } },
      documentMeta: true,
      team: { select: { url: true } },
      scheduledSend: { select: { userId: true } },
    },
  });

  // The envelope may be gone by the time the job runs. Nothing to tell anyone then.
  if (!envelope) {
    return;
  }

  const isToRecipient =
    payload.kind === 'RECIPIENT_REASSIGNED' ||
    payload.kind === 'COMMENT_FROM_TEAM' ||
    payload.kind === 'SIGNER_DEADLINE_PASSED';

  // Solid Ten: an owner who lost access to the team gets no more notices of its documents.
  // Solid Ten Sign (S-2): a failed seal still reaches the server operators (their copy is sent below).
  const canOwnerReach =
    isToRecipient || (await canOwnerReachTeam({ userId: envelope.user.id, teamId: envelope.teamId }));

  if (!canOwnerReach && payload.kind !== 'SEAL_FAILED') {
    return;
  }

  const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);

  // The old recipient's notice follows the document's "recipient removed" email switch.
  if (payload.kind === 'RECIPIENT_REASSIGNED' && !emailSettings.recipientRemoved) {
    return;
  }

  // Comment notices follow the switches for the matching signing emails: a
  // reply to a recipient goes only when signing emails go to recipients, and a
  // question reaches the owner only when they get "recipient signed" emails.
  if (payload.kind === 'COMMENT_FROM_TEAM' && !emailSettings.recipientSigningRequest) {
    return;
  }

  if (payload.kind === 'COMMENT_FROM_RECIPIENT' && !emailSettings.recipientSigned) {
    return;
  }

  // The deadline notice goes where the signing request went: by email, and only
  // when this document emails signing requests at all.
  if (
    payload.kind === 'SIGNER_DEADLINE_PASSED' &&
    (!emailSettings.recipientSigningRequest || envelope.documentMeta?.distributionMethod === 'NONE')
  ) {
    return;
  }

  const { branding, emailLanguage, senderEmail, replyToEmail, emailsDisabled, emailTransport } = await getEmailContext({
    emailType: isToRecipient ? 'RECIPIENT' : 'INTERNAL',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  // Solid Ten Sign (S-2): a failed seal is a server-health notice for the operators, sent like the
  // other operator notices whatever the team's email settings; the owner's copy below obeys them.
  if (payload.kind === 'SEAL_FAILED' && envelope.status === 'PENDING') {
    const isOwnerCopySent = canOwnerReach && !emailsDisabled;

    await runTaskAtMostOnce(io, 'send-seal-failed-operator-notice', async (markSending) => {
      await notifyOperatorsOfSealFailed({
        envelopeId: envelope.id,
        title: envelope.title,
        isRejected: payload.isRejected,
        excludeAddress: isOwnerCopySent ? envelope.user.email : undefined,
        beforeSend: markSending,
      });
    });
  }

  if (emailsDisabled) {
    return;
  }

  const i18n = await getI18nInstance(emailLanguage);

  const documentLink = `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(envelope.team.url)}/${envelope.id}`;

  const notice: Notice | null = await match(payload)
    .with({ kind: 'SCHEDULED_SEND_FAILED' }, async ({ reason }): Promise<Notice> => {
      const to = [{ name: envelope.user.name || '', address: envelope.user.email }];

      const schedulerId = envelope.scheduledSend?.userId;

      if (schedulerId && schedulerId !== envelope.user.id) {
        const scheduler = await prisma.user.findUnique({
          where: { id: schedulerId },
          select: { email: true, name: true },
        });

        if (scheduler) {
          to.push({ name: scheduler.name || '', address: scheduler.email });
        }
      }

      return {
        to,
        subject: i18n._(msg`"${envelope.title}" was not sent`),
        heading: i18n._(msg`Your scheduled document was not sent`),
        paragraphs: [
          i18n._(msg`Solid Ten Sign tried to send "${envelope.title}" at the scheduled time, but could not.`),
          i18n._(msg`Reason: ${reason}`),
          i18n._(msg`The document is still a draft. Fix the problem, then send or schedule it again.`),
        ],
        actionLabel: i18n._(msg`Open document`),
        actionLink: documentLink,
      };
    })
    .with(
      { kind: 'RECIPIENT_REASSIGNED' },
      async ({ oldEmail, oldName, newName, isSelfReassigned }): Promise<Notice> => ({
        to: [{ name: oldName, address: oldEmail }],
        subject: i18n._(msg`"${envelope.title}" was passed to someone else`),
        // Solid Ten Sign (SEC2-M2): name the new person only to the one who chose them. A job
        // queued before this change may still carry a name for a sender correction: ignore it.
        heading:
          isSelfReassigned && newName
            ? i18n._(msg`You passed "${envelope.title}" to ${newName}`)
            : i18n._(msg`"${envelope.title}" was passed to someone else`),
        paragraphs: [
          isSelfReassigned && newName
            ? i18n._(msg`${newName} will get their own link to the document. You do not need to do anything.`)
            : i18n._(msg`The sender asked someone else to act on this document instead of you.`),
          i18n._(msg`Your old signing link no longer works.`),
        ],
      }),
    )
    .with(
      { kind: 'RECIPIENT_SELF_REASSIGNED' },
      async ({ fromEmail, fromName, toEmail, toName, reason }): Promise<Notice> => {
        const from = fromName ? `${fromName} (${fromEmail})` : fromEmail;
        const to = toName ? `${toName} (${toEmail})` : toEmail;

        return {
          to: [{ name: envelope.user.name || '', address: envelope.user.email }],
          subject: i18n._(msg`A signer passed "${envelope.title}" to someone else`),
          heading: i18n._(msg`${from} passed "${envelope.title}" to ${to}`),
          paragraphs: [
            i18n._(msg`${from} used their signing link to hand the request to ${to}. ${to} now has their own link.`),
            ...(reason ? [i18n._(msg`Reason given: ${reason}`)] : []),
            i18n._(msg`If you did not expect this, open the document and reassign or cancel it.`),
          ],
          actionLabel: i18n._(msg`Open document`),
          actionLink: documentLink,
        };
      },
    )
    .with({ kind: 'COMMENT_FROM_RECIPIENT' }, async ({ commentId }): Promise<Notice | null> => {
      const comment = await prisma.envelopeComment.findFirst({ where: { id: commentId, envelopeId: envelope.id } });

      if (!comment) {
        return null;
      }

      const author = comment.authorName || comment.authorEmail;

      return {
        to: [{ name: envelope.user.name || '', address: envelope.user.email }],
        subject: i18n._(msg`New comment on "${envelope.title}"`),
        heading: i18n._(msg`${author} left a comment`),
        paragraphs: [
          i18n._(msg`${author} wrote on "${envelope.title}":`),
          truncateCommentForEmail(comment.body),
          i18n._(msg`Open the document to reply.`),
        ],
        actionLabel: i18n._(msg`Open document`),
        actionLink: documentLink,
      };
    })
    .with({ kind: 'COMMENT_FROM_TEAM' }, async ({ commentId, recipientId }): Promise<Notice | null> => {
      const [comment, recipient] = await Promise.all([
        prisma.envelopeComment.findFirst({
          where: { id: commentId, envelopeId: envelope.id },
          include: { thread: { select: { key: true } } },
        }),
        prisma.recipient.findFirst({ where: { id: recipientId, envelopeId: envelope.id } }),
      ]);

      // Nothing to say once the recipient has finished, or if the document closed.
      if (!comment || !recipient || recipient.signingStatus !== 'NOT_SIGNED' || envelope.status !== 'PENDING') {
        return null;
      }

      // Solid Ten Sign (AUD-C8): the thread must still be visible to the person behind this row
      // now. After a handover the private thread belongs to the previous person.
      if (
        comment.thread.key !== SHARED_COMMENT_THREAD_KEY &&
        comment.thread.key !== getRecipientCommentThreadKey(recipient)
      ) {
        return null;
      }

      return {
        to: [{ name: recipient.name, address: recipient.email }],
        subject: i18n._(msg`New reply on "${envelope.title}"`),
        heading: i18n._(msg`You have a reply on "${envelope.title}"`),
        paragraphs: [
          truncateCommentForEmail(comment.body),
          i18n._(msg`Open the document to read the conversation or answer.`),
        ],
        actionLabel: i18n._(msg`Open document`),
        actionLink: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
      };
    })
    .with({ kind: 'SIGNER_DEADLINE_PASSED' }, async ({ recipientId, recipientEmail }): Promise<Notice | null> => {
      const recipient = await prisma.recipient.findFirst({ where: { id: recipientId, envelopeId: envelope.id } });

      if (!recipient || recipient.signingStatus !== 'NOT_SIGNED' || !isRecipientEmailValidForSending(recipient)) {
        return null;
      }

      // Solid Ten Sign (AUD-C8): written for the person whose link expired; a person who took
      // over the link since then does not get it.
      if (recipientEmail !== undefined && recipientEmail.toLowerCase() !== recipient.email.toLowerCase()) {
        return null;
      }

      const sender = envelope.user.name || envelope.user.email;

      return {
        to: [{ name: recipient.name, address: recipient.email }],
        subject: i18n._(msg`The signing deadline for "${envelope.title}" has passed`),
        heading: i18n._(msg`The signing deadline for "${envelope.title}" has passed`),
        paragraphs: [
          i18n._(msg`Your link to this document no longer works.`),
          i18n._(msg`If you still need to sign, contact ${sender}.`),
        ],
      };
    })
    .with({ kind: 'SIGNING_REQUEST_NOT_DELIVERED' }, async ({ recipientId }): Promise<Notice | null> => {
      const recipient = await prisma.recipient.findFirst({ where: { id: recipientId, envelopeId: envelope.id } });

      // Sent or signed in the meantime (a resend, a text): nothing to report.
      if (!recipient?.deliveryFailedAt || recipient.sendStatus === 'SENT') {
        return null;
      }

      const who = recipient.name ? `${recipient.name} (${recipient.email})` : recipient.email;

      return {
        to: [{ name: envelope.user.name || '', address: envelope.user.email }],
        subject: i18n._(msg`"${envelope.title}": a signing request was not delivered`),
        heading: i18n._(msg`A signing request was not delivered`),
        paragraphs: [
          i18n._(
            msg`Solid Ten Sign could not deliver the signing request for "${envelope.title}" to ${who}. It tried for about five hours.`,
          ),
          i18n._(
            msg`Check the email address. Then open the document and use Resend on that recipient, or copy their signing link and send it another way.`,
          ),
        ],
        actionLabel: i18n._(msg`Open document`),
        actionLink: documentLink,
      };
    })
    .with(
      { kind: 'COMPLETED_DOCUMENT_NOT_DELIVERED' },
      async ({ recipientIds, isOwnerCopyUndelivered }): Promise<Notice | null> => {
        const recipients = await prisma.recipient.findMany({
          where: { id: { in: recipientIds }, envelopeId: envelope.id },
          orderBy: { id: 'asc' },
        });

        if (recipients.length === 0 && !isOwnerCopyUndelivered) {
          return null;
        }

        const who = recipients.map((recipient) =>
          recipient.name ? `${recipient.name} (${recipient.email})` : recipient.email,
        );

        return {
          to: [{ name: envelope.user.name || '', address: envelope.user.email }],
          subject: i18n._(msg`"${envelope.title}": the signed copy was not delivered`),
          heading: i18n._(msg`The signed copy was not delivered`),
          paragraphs: [
            who.length > 0
              ? i18n._(
                  msg`"${envelope.title}" is signed by everyone, but Solid Ten Sign could not email the signed copy to ${who.join(', ')}. It tried for about five hours.`,
                )
              : i18n._(
                  msg`"${envelope.title}" is signed by everyone, but Solid Ten Sign could not email your own signed copy. It tried for about five hours.`,
                ),
            ...(who.length > 0 && isOwnerCopyUndelivered
              ? [i18n._(msg`Your own signed copy was not delivered either.`)]
              : []),
            i18n._(
              msg`Check the email addresses. Then open the document and use Resend signed copy on that recipient, or download the signed copy and send it another way.`,
            ),
          ],
          actionLabel: i18n._(msg`Open document`),
          actionLink: documentLink,
        };
      },
    )
    .with({ kind: 'SEAL_FAILED' }, ({ isRejected }): Notice | null => {
      // The owner's copy (team mail). The operators got theirs above, whatever the team settings.
      if (!canOwnerReach || envelope.status !== 'PENDING') {
        return null;
      }

      return {
        to: [{ name: envelope.user.name || '', address: envelope.user.email }],
        ...sealFailedNoticeText(i18n, { title: envelope.title, isRejected }),
        actionLabel: i18n._(msg`Open document`),
        actionLink: documentLink,
      };
    })
    .exhaustive();

  if (!notice) {
    return;
  }

  // Solid Ten Sign (RT3-M1): never mail the built-in service accounts; they cannot receive it.
  const to = withoutServiceAccounts(notice.to);

  if (to.length === 0) {
    return;
  }

  const template = createElement(SolidTenNoticeTemplate, {
    heading: notice.heading,
    paragraphs: notice.paragraphs,
    actionLabel: notice.actionLabel,
    actionLink: notice.actionLink,
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
  });

  // Solid Ten: at most once; a re-run after a crash during the send does not send it twice.
  await runTaskAtMostOnce(io, 'send-solidten-notice-email', async (markSending) => {
    const [html, text] = await Promise.all([
      renderEmailWithI18N(template, { lang: emailLanguage, branding }),
      renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
    ]);

    await markSending();

    await emailTransport.sendMail({
      to,
      from: senderEmail,
      replyTo: isToRecipient ? replyToEmail : undefined,
      subject: notice.subject,
      html,
      text,
    });
  });
};
