import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { AppError, AppErrorCode } from '../../errors/app-error';

/**
 * Solid Ten: one lock for every writer that can move an envelope out of PENDING.
 *
 * Signing, rejecting, cancelling and deleting all take a row lock on the envelope
 * (SELECT ... FOR UPDATE) inside their transaction before they write. Postgres then runs
 * them one after the other, and each one sees the result of the one before it. The seal
 * job does not take the lock; it moves the envelope with a conditional update
 * (`WHERE status = 'PENDING'`), which waits for the lock and re-checks the status.
 */

type TransactionClient = Prisma.TransactionClient;

/**
 * Lock the envelope row until the transaction ends and return its current status.
 * Returns null when the envelope does not exist.
 */
export const lockEnvelopeRow = async (tx: TransactionClient, envelopeId: string) => {
  const rows = await tx.$queryRaw<Array<{ status: DocumentStatus }>>`
    SELECT "status" FROM "Envelope" WHERE "id" = ${envelopeId} FOR UPDATE
  `;

  return rows[0]?.status ?? null;
};

/**
 * True when nobody is left to act: every signing recipient has signed, or one has rejected.
 * The envelope is still PENDING but the seal job is about to (or should) finish it.
 */
export const isEnvelopeAwaitingSeal = async (tx: TransactionClient, envelopeId: string) => {
  const recipients = await tx.recipient.findMany({
    where: {
      envelopeId,
      role: { not: RecipientRole.CC },
    },
    select: { signingStatus: true },
  });

  return getIsAwaitingSeal(recipients);
};

export const getIsAwaitingSeal = (recipients: Array<{ signingStatus: SigningStatus }>) => {
  if (recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED)) {
    return true;
  }

  return recipients.length > 0 && recipients.every((recipient) => recipient.signingStatus === SigningStatus.SIGNED);
};

export const ENVELOPE_AWAITING_SEAL_MESSAGE =
  'Everyone has signed this document and it is being finalized. It can no longer be canceled or deleted.';

/** Solid Ten Sign (SEC3-L1): the same refusal when the cause is a decline, not a full set of signatures. */
export const ENVELOPE_DECLINED_AWAITING_SEAL_MESSAGE =
  'A recipient declined this document and it is being finalized. It can no longer be canceled or deleted.';

/** Why the envelope is waiting for its seal, or null when someone can still act. */
export const getAwaitingSealReason = async (
  tx: TransactionClient,
  envelopeId: string,
): Promise<'DECLINED' | 'ALL_SIGNED' | null> => {
  const recipients = await tx.recipient.findMany({
    where: { envelopeId, role: { not: RecipientRole.CC } },
    select: { signingStatus: true },
  });

  if (!getIsAwaitingSeal(recipients)) {
    return null;
  }

  return recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED) ? 'DECLINED' : 'ALL_SIGNED';
};

/**
 * Lock the envelope and check that it is still PENDING. When `refuseWhenAwaitingSeal` is set,
 * also refuse when every signer has signed (or one has rejected): the seal job owns the
 * envelope from that moment.
 */
export const lockPendingEnvelope = async (
  tx: TransactionClient,
  envelopeId: string,
  options: { refuseWhenAwaitingSeal?: boolean; allowedStatuses?: DocumentStatus[] } = {},
) => {
  const { refuseWhenAwaitingSeal = false, allowedStatuses = [DocumentStatus.PENDING] } = options;

  const status = await lockEnvelopeRow(tx, envelopeId);

  if (status === null) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
      statusCode: 404,
    });
  }

  if (!allowedStatuses.includes(status)) {
    throw plainRefusal(
      getEnvelopeStatusErrorCode(status),
      'This document is no longer open for signing. Reload the page.',
      { envelopeId, status },
      { statusCode: 400 },
    );
  }

  if (refuseWhenAwaitingSeal && status === DocumentStatus.PENDING) {
    const reason = await getAwaitingSealReason(tx, envelopeId);

    if (reason) {
      const message = reason === 'DECLINED' ? ENVELOPE_DECLINED_AWAITING_SEAL_MESSAGE : ENVELOPE_AWAITING_SEAL_MESSAGE;

      throw new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message, statusCode: 400 });
    }
  }

  return status;
};

export const getEnvelopeStatusErrorCode = (status: DocumentStatus) => {
  const codes: Record<DocumentStatus, AppErrorCode> = {
    [DocumentStatus.DRAFT]: AppErrorCode.ENVELOPE_DRAFT,
    [DocumentStatus.COMPLETED]: AppErrorCode.ENVELOPE_COMPLETED,
    [DocumentStatus.REJECTED]: AppErrorCode.ENVELOPE_REJECTED,
    [DocumentStatus.CANCELLED]: AppErrorCode.ENVELOPE_CANCELLED,
    [DocumentStatus.PENDING]: AppErrorCode.INVALID_REQUEST,
  };

  return codes[status];
};

/**
 * Run `callback` in a transaction that holds the envelope lock and has checked the status.
 */
export const withLockedPendingEnvelope = async <T>(
  envelopeId: string,
  callback: (tx: TransactionClient) => Promise<T>,
  options: { refuseWhenAwaitingSeal?: boolean; allowedStatuses?: DocumentStatus[] } = {},
) =>
  await prisma.$transaction(async (tx) => {
    await lockPendingEnvelope(tx, envelopeId, options);

    return await callback(tx);
  });

export const RECIPIENT_ALREADY_ACTED_MESSAGE = 'This recipient has already signed or declined this document.';

export const ENVELOPE_DECLINED_MESSAGE =
  'Another recipient declined this document, so it can no longer be signed or declined.';

/**
 * Solid Ten Sign (FS2-C1): under the envelope lock, refuse a recipient action when the
 * envelope is already on its way to being finished (someone declined, or everyone signed).
 * The seal job owns it then.
 */
export const assertEnvelopeOpenForRecipientAction = async (
  tx: TransactionClient,
  envelopeId: string,
  /** The recipient who is acting. Their own decline or signature gets its own wording (SEC3-L1). */
  recipientId?: number,
) => {
  const awaitingSealReason = await getAwaitingSealReason(tx, envelopeId);

  if (awaitingSealReason === null) {
    return;
  }

  const actor =
    recipientId === undefined
      ? null
      : await tx.recipient.findFirst({ where: { id: recipientId, envelopeId }, select: { signingStatus: true } });

  const hasActed = actor !== null && actor.signingStatus !== SigningStatus.NOT_SIGNED;

  const message = hasActed ? RECIPIENT_ALREADY_ACTED_MESSAGE : ENVELOPE_DECLINED_MESSAGE;

  // Solid Ten: someone else declined. Use upstream's code, so the signing page shows its own
  // "Document rejected" toast. The refusal itself is the same.
  const code =
    !hasActed && awaitingSealReason === 'DECLINED' ? AppErrorCode.ENVELOPE_REJECTED : AppErrorCode.INVALID_REQUEST;

  throw new AppError(code, { message, userMessage: message, statusCode: 400 });
};

/**
 * Solid Ten Sign (FS2-C1): move a recipient from NOT_SIGNED to REJECTED inside the locked
 * transaction. Only a recipient who has not acted can decline; the loser of a race gets a
 * clean 400 and writes nothing.
 */
export const rejectRecipientUnderLock = async (
  tx: TransactionClient,
  { recipientId, token, reason, now = new Date() }: { recipientId: number; token: string; reason: string; now?: Date },
) => {
  const { count } = await tx.recipient.updateMany({
    where: { id: recipientId, token, signingStatus: SigningStatus.NOT_SIGNED },
    data: { signedAt: now, signingStatus: SigningStatus.REJECTED, rejectionReason: reason },
  });

  if (count === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: RECIPIENT_ALREADY_ACTED_MESSAGE,
      userMessage: RECIPIENT_ALREADY_ACTED_MESSAGE,
      statusCode: 400,
    });
  }

  return await tx.recipient.findUniqueOrThrow({ where: { id: recipientId } });
};

export const RECIPIENT_CHANGED_MESSAGE =
  'A recipient changed while you were editing (they signed, declined or got a new link). Reload and try again.';

type TExpectedRecipient = { id: number; token: string; signingStatus: SigningStatus };

/**
 * Solid Ten Sign (FS2-C1, wider): every path that changes or removes a recipient of an envelope
 * takes the envelope lock first (always envelope row, then recipient rows, so no deadlock),
 * refuses a pending envelope that is already being finished, and checks that each recipient it
 * read before the transaction is unchanged (same link, same signing status). A path that loses
 * a race against a signature, a decline or another handover then writes nothing.
 */
export const lockEnvelopeForRecipientChange = async (
  tx: TransactionClient,
  envelopeId: string,
  expected: TExpectedRecipient[] = [],
) => {
  const status = await lockEnvelopeRow(tx, envelopeId);

  if (status === null) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Document not found', statusCode: 404 });
  }

  if (status === DocumentStatus.PENDING) {
    await assertEnvelopeOpenForRecipientAction(tx, envelopeId, expected.length === 1 ? expected[0].id : undefined);
  }

  if (expected.length === 0) {
    return status;
  }

  const current = await tx.recipient.findMany({
    where: { id: { in: expected.map((recipient) => recipient.id) } },
    select: { id: true, token: true, signingStatus: true },
  });

  const isUnchanged = expected.every((recipient) => {
    const now = current.find((candidate) => candidate.id === recipient.id);

    return now && now.token === recipient.token && now.signingStatus === recipient.signingStatus;
  });

  if (!isUnchanged) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: RECIPIENT_CHANGED_MESSAGE,
      userMessage: RECIPIENT_CHANGED_MESSAGE,
      statusCode: 409,
    });
  }

  return status;
};
