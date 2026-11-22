import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus } from '@prisma/client';
import { z } from 'zod';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { jobs } from '../../client';

const ZCompletedEmailsPayloadSchema = z.object({
  envelopeId: z.string(),
  resend: z.object({ recipientId: z.number() }).optional(),
});

const OWNER_TASK = 'send-owner-completed-email';
const RECIPIENT_TASK_PREFIX = 'send-completed-email-';

/**
 * Solid Ten: the completion emails (the signed copy to the owner and each recipient) failed on
 * every attempt (about five hours). Before, only failedLast24h counted it; nobody was told. Now,
 * as for a signing request: the recipient marked (deliveryFailedAt), an EMAIL_NOT_DELIVERED audit
 * entry per recipient whose copy did not go out, and a notice to the owner (an email job with the same retries, so it arrives once mail
 * works again).
 *
 * Who did not get it (F4-M1): the job keeps its plan (task completed-email-plan: the owner's
 * copy or not, and the recipients); every planned copy whose own task (send-owner-completed-email,
 * send-completed-email-<recipientId>) is not COMPLETED was not sent, also one whose send never
 * started. Without a plan (a job queued before it existed) the copies' tasks decide, as before.
 * The owner's copy gets its entry too (recipientRole OWNER), and the notice says so.
 */
const PLAN_TASK = 'completed-email-plan';

type TPlan = { isOwnerCopyIntended: boolean; recipientIds: number[] };

/** The copies not sent: from the plan when there is one, else from the copies' own tasks. */
export const findUndeliveredCopies = (
  tasks: { name: string; status: BackgroundJobStatus; result: unknown }[],
): { isOwnerCopyUndelivered: boolean; recipientIds: number[] } => {
  const done = new Set(tasks.filter((task) => task.status === BackgroundJobStatus.COMPLETED).map((task) => task.name));
  const plan = tasks.find((task) => task.name === PLAN_TASK && task.status === BackgroundJobStatus.COMPLETED)?.result as
    | TPlan
    | undefined;

  if (plan && Array.isArray(plan.recipientIds)) {
    return {
      isOwnerCopyUndelivered: plan.isOwnerCopyIntended && !done.has(OWNER_TASK),
      recipientIds: plan.recipientIds.filter((id) => !done.has(`${RECIPIENT_TASK_PREFIX}${id}`)),
    };
  }

  const open = tasks.filter((task) => task.status !== BackgroundJobStatus.COMPLETED);

  return {
    isOwnerCopyUndelivered: open.some((task) => task.name === OWNER_TASK),
    recipientIds: open
      .filter((task) => task.name.startsWith(RECIPIENT_TASK_PREFIX))
      .map((task) => Number(task.name.slice(RECIPIENT_TASK_PREFIX.length)))
      .filter((id) => Number.isInteger(id)),
  };
};

export const markCompletedEmailsUndelivered = async ({
  jobRowId,
  payload,
  attempts,
}: {
  jobRowId: string;
  payload: unknown;
  attempts: number;
}) => {
  const parsed = ZCompletedEmailsPayloadSchema.safeParse(payload);

  if (!parsed.success) {
    return;
  }

  const tasks = await prisma.backgroundJobTask.findMany({
    where: { jobId: jobRowId },
    select: { name: true, status: true, result: true },
  });

  const { isOwnerCopyUndelivered, recipientIds } = findUndeliveredCopies(tasks);

  if (recipientIds.length === 0 && !isOwnerCopyUndelivered) {
    return;
  }

  const recipients = await prisma.recipient.findMany({
    where: { id: { in: recipientIds }, envelopeId: parsed.data.envelopeId },
  });

  // Marked on the recipient, as a failed signing request is: the document page shows "Copy not
  // delivered" (when the mark is newer than the completion) and the API returns deliveryFailedAt.
  await prisma.recipient.updateMany({
    where: { id: { in: recipients.map((recipient) => recipient.id) } },
    data: { deliveryFailedAt: new Date() },
  });

  for (const recipient of recipients) {
    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_NOT_DELIVERED,
        envelopeId: recipient.envelopeId,
        data: {
          recipientId: recipient.id,
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          recipientRole: recipient.role,
          emailType: 'DOCUMENT_COMPLETED',
          attempts,
        },
      }),
    });
  }

  // The owner's own copy, recorded the same way (EMAIL_SENT records it with recipientRole OWNER).
  if (isOwnerCopyUndelivered) {
    const envelope = await prisma.envelope.findUnique({
      where: { id: parsed.data.envelopeId },
      select: { user: { select: { id: true, email: true, name: true } } },
    });

    if (envelope) {
      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_NOT_DELIVERED,
          envelopeId: parsed.data.envelopeId,
          data: {
            recipientId: envelope.user.id,
            recipientEmail: envelope.user.email,
            recipientName: envelope.user.name ?? '',
            recipientRole: 'OWNER',
            emailType: 'DOCUMENT_COMPLETED',
            attempts,
          },
        }),
      });
    }
  }

  await jobs.triggerJob({
    // Once per envelope, also when the final-failure path runs twice. A "Resend signed copy" that
    // is given up tells the owner again (once per resend job).
    id: parsed.data.resend
      ? `completed-not-delivered:${parsed.data.envelopeId}:${jobRowId}`
      : `completed-not-delivered:${parsed.data.envelopeId}`,
    name: 'send.solidten.notice.email',
    payload: {
      kind: 'COMPLETED_DOCUMENT_NOT_DELIVERED',
      envelopeId: parsed.data.envelopeId,
      recipientIds: recipients.map((recipient) => recipient.id),
      isOwnerCopyUndelivered,
    },
  });
};
