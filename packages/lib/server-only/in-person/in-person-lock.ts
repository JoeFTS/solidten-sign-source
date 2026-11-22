import { prisma } from '@documenso/prisma';
import type { InPersonSigningSession } from '@prisma/client';
import { InPersonSigningPhase } from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';

// Kept free of email and i18n imports: the tRPC and route middleware load this
// on every authenticated request.

export type InPersonHost = {
  id: number;
  name: string | null;
  email: string;
};

export type InPersonEndReason = 'EXITED' | 'PIN_LOCKOUT' | 'EXPIRED' | 'REPLACED' | 'ENDED_ELSEWHERE';

/**
 * Solid Ten Sign (AUD-3): only the host PIN (EXITED) gives the locked sign-in
 * back. An end the device holder did not authorise with the PIN signs the
 * device out. REPLACED is not here: a new session from the same, unlocked
 * sign-in replaces the old one.
 */
const SIGN_OUT_END_REASONS: ReadonlySet<InPersonEndReason> = new Set(['EXPIRED', 'ENDED_ELSEWHERE', 'PIN_LOCKOUT']);

const hostAuditUser = (host: InPersonHost) => ({ id: host.id, name: host.name, email: host.email });

export const isInPersonSessionActive = (
  session: Pick<InPersonSigningSession, 'endedAt' | 'expiresAt'>,
  now = new Date(),
) => !session.endedAt && session.expiresAt > now;

/**
 * End a session. EXITED releases the host's sign-in; an end without the PIN
 * signs the device out. Safe to call twice.
 */
export const endInPersonSession = async ({
  session,
  host,
  actor,
  reason,
  requestMetadata,
}: {
  session: InPersonSigningSession;
  host: InPersonHost;
  /** Who ended it, when not the host (ENDED_ELSEWHERE). The audit entry names them. */
  actor?: InPersonHost;
  reason: InPersonEndReason;
  requestMetadata?: RequestMetadata;
}) => {
  const endedBy = actor ?? host;

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.inPersonSigningSession.updateMany({
      where: { id: session.id, endedAt: null },
      data: {
        endedAt: new Date(),
        endReason: reason,
        phase: InPersonSigningPhase.HOST,
        recipientId: null,
        turnToken: null,
        turnTokenExpiresAt: null,
      },
    });

    if (SIGN_OUT_END_REASONS.has(reason)) {
      await tx.session.deleteMany({
        where: { id: session.authSessionId, stInPersonSessionId: session.id },
      });
    } else {
      await tx.session.updateMany({
        where: { id: session.authSessionId, stInPersonSessionId: session.id },
        data: { stInPersonSessionId: null },
      });
    }

    if (count === 0) {
      return;
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.IN_PERSON_SESSION_ENDED,
        envelopeId: session.envelopeId,
        user: hostAuditUser(endedBy),
        requestMetadata,
        data: {
          sessionId: session.id,
          hostUserId: host.id,
          hostName: host.name ?? '',
          hostEmail: host.email,
          reason,
          endedByUserId: endedBy.id,
          endedByName: endedBy.name ?? '',
          endedByEmail: endedBy.email,
        },
      }),
    });
  });
};

export const getInPersonHost = async (hostUserId: number): Promise<InPersonHost> => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: hostUserId },
    select: { id: true, name: true, email: true },
  });

  return user;
};

/**
 * The active lock on a sign-in session, if any. Clears a stale marker.
 */
export const getInPersonLockId = async (authSession: { id: string; stInPersonSessionId?: string | null }) => {
  if (!authSession.stInPersonSessionId) {
    return null;
  }

  const session = await prisma.inPersonSigningSession.findUnique({
    where: { id: authSession.stInPersonSessionId },
    select: { id: true, authSessionId: true, endedAt: true, endReason: true, expiresAt: true, hostUserId: true },
  });

  if (session && session.authSessionId === authSession.id && isInPersonSessionActive(session)) {
    return session.id;
  }

  if (session && session.authSessionId === authSession.id && !session.endedAt) {
    const fullSession = await prisma.inPersonSigningSession.findUniqueOrThrow({ where: { id: session.id } });

    await endInPersonSession({
      session: fullSession,
      host: await getInPersonHost(session.hostUserId),
      reason: 'EXPIRED',
    });

    // Solid Ten Sign (AUD-3): the device is now signed out, but this request already
    // holds its sign-in. Keep it refused as locked.
    return session.id;
  }

  // Solid Ten Sign (AUD-3 follow-up): a session that ended without the PIN signed this device
  // out. A request that loaded the sign-in before that end committed still holds it, so it
  // stays refused as locked, whatever the timing. Only EXITED (the PIN) gives the sign-in back.
  if (
    session &&
    session.authSessionId === authSession.id &&
    session.endedAt &&
    SIGN_OUT_END_REASONS.has(session.endReason as InPersonEndReason)
  ) {
    return session.id;
  }

  // Only the PIN exit (EXITED), or a new session from this same unlocked sign-in (REPLACED),
  // gives the sign-in back.
  if (
    session &&
    session.authSessionId === authSession.id &&
    session.endedAt &&
    (session.endReason === 'EXITED' || session.endReason === 'REPLACED')
  ) {
    await prisma.session.updateMany({
      where: { id: authSession.id, stInPersonSessionId: authSession.stInPersonSessionId },
      data: { stInPersonSessionId: null },
    });

    return null;
  }

  // Solid Ten Sign (AUD-3 follow-up 2): the marker points at a row that is gone (envelope
  // deleted, purged or its team removed: the cascade takes the row) or that does not belong to
  // this sign-in. Fail closed: sign the device out and keep this request refused as locked.
  await prisma.session.deleteMany({
    where: { id: authSession.id, stInPersonSessionId: authSession.stInPersonSessionId },
  });

  return authSession.stInPersonSessionId;
};
