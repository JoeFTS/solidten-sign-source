import { prisma } from '@documenso/prisma';
import type { Prisma, Recipient } from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE, DOCUMENT_EMAIL_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';

/**
 * Solid Ten: the reminder count and the audit entry of a reminder cut off during its send
 * (FS2-L2).
 *
 * The count moves when a reminder is sent (in the same transaction as the at-most-once
 * "sending" marker), not when it is claimed: a claim cut off before its task was recorded
 * counted a reminder that was never sent.
 */
export const countReminder = async (recipientId: number, tx: Pick<Prisma.TransactionClient, 'recipient'> = prisma) =>
  await tx.recipient.update({ where: { id: recipientId }, data: { reminderCount: { increment: 1 } } });

export const readReminderCount = async (recipientId: number) =>
  (await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId }, select: { reminderCount: true } }))
    .reminderCount;

/**
 * A re-run that skips a send cut off during the SMTP call cannot know whether the email reached
 * the mail server. It records an EMAIL_SENT entry marked deliveryUnconfirmed, unless an entry for
 * this reminder was already written after the "sending" marker. It never sends.
 */
export const createCutOffReminderRecorder =
  ({
    envelope,
    recipient,
    now,
  }: {
    envelope: { id: string };
    recipient: Pick<Recipient, 'id' | 'email' | 'name' | 'role'>;
    now: Date;
  }) =>
  async (startedAt: Date | null) => {
    const alreadyRecorded = await prisma.documentAuditLog.count({
      where: {
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
        createdAt: { gte: startedAt ?? now },
        AND: [
          { data: { path: ['emailType'], equals: DOCUMENT_EMAIL_TYPE.REMINDER } },
          { data: { path: ['recipientId'], equals: recipient.id } },
        ],
      },
    });

    if (alreadyRecorded > 0) {
      return;
    }

    console.warn(
      `[JOBS]: Reminder to recipient ${recipient.id} was cut off during its send; recorded as not confirmed`,
    );

    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
        envelopeId: envelope.id,
        data: {
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          recipientId: recipient.id,
          recipientRole: recipient.role,
          emailType: DOCUMENT_EMAIL_TYPE.REMINDER,
          isResending: false,
          deliveryUnconfirmed: true,
        },
      }),
    });
  };
