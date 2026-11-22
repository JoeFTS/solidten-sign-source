import { prisma } from '@documenso/prisma';

/**
 * Solid Ten: a claimed reminder holds a lease instead of `nextReminderAt = null`.
 *
 * While the lease runs, the reminder sweep (which looks for `nextReminderAt <= now`) skips the
 * recipient. When the job finishes, it replaces the lease with the real next reminder time (or
 * null when no reminder is left). When the job is lost for good, the lease ends and the sweep
 * claims the recipient again. The lease is longer than the job recovery needs to re-run a
 * crashed job (PENDING after 2 minutes, PROCESSING after its timeout).
 */
export const REMINDER_LEASE_MS = 15 * 60_000;

export const getReminderLeaseUntil = (claimedAt: Date) => new Date(claimedAt.getTime() + REMINDER_LEASE_MS);

/** End the lease without scheduling another reminder (the recipient no longer gets reminders). */
export const stopReminders = async (recipientId: number) => {
  await prisma.recipient.updateMany({
    where: { id: recipientId },
    data: { nextReminderAt: null },
  });
};
