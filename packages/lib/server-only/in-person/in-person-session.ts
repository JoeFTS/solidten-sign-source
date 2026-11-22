import { prisma } from '@documenso/prisma';
import type { InPersonSigningSession, Prisma, Recipient } from '@prisma/client';
import { EnvelopeType, InPersonSigningPhase, RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { TInPersonHostMarker } from '../../types/solidten-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import {
  getInPersonEnvelopeBlockReason,
  getInPersonSignerBlockReason,
  getInPersonTurnRecipients,
  IN_PERSON_ENVELOPE_BLOCK_MESSAGES,
  IN_PERSON_MAX_PIN_ATTEMPTS,
  IN_PERSON_SESSION_LIFETIME_MS,
  IN_PERSON_SIGNER_BLOCK_MESSAGES,
  type InPersonSignerBlockReason,
  isInPersonNameConfirmed,
  isValidInPersonPin,
} from '../../utils/in-person';
import { formatDocumentsPath } from '../../utils/teams';
import { checkEmailAccessCodeWithLimit } from '../2fa/email/email-access-code-lockout';
import { send2FATokenEmail } from '../2fa/email/send-2fa-token-email';
import { compareSync, hashSync } from '../auth/hash';
import { getTeamSettings } from '../team/get-team-settings';
import { canHostInPerson, IN_PERSON_NOT_HOST_MESSAGE } from './assert-may-host-in-person';
import { endInPersonSession, getInPersonHost, type InPersonHost, isInPersonSessionActive } from './in-person-lock';

import { CLEARED_TURN_TOKEN, createInPersonTurnToken, getInPersonTurnTokenExpiry } from './in-person-turn-token';

export type { InPersonHost } from './in-person-lock';

/** The host's browser: the signed-in user and the sign-in session that is locked. */
export type InPersonDevice = {
  host: InPersonHost;
  authSessionId: string;
  requestMetadata?: RequestMetadata;
};

const SESSION_INCLUDE = {
  envelope: {
    include: {
      recipients: { orderBy: [{ signingOrder: 'asc' }, { id: 'asc' }] },
      documentMeta: true,
      team: { select: { url: true } },
    },
  },
} satisfies Prisma.InPersonSigningSessionInclude;

type LoadedSession = Prisma.InPersonSigningSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

const hostAuditUser = (host: InPersonHost) => ({ id: host.id, name: host.name, email: host.email });

const isActive = isInPersonSessionActive;
const endSession = endInPersonSession;
const getHost = getInPersonHost;

const toHostMarker = (session: InPersonSigningSession, host: InPersonHost): TInPersonHostMarker => ({
  sessionId: session.id,
  hostUserId: host.id,
  hostName: host.name ?? '',
  hostEmail: host.email,
  emailCodeVerified: Boolean(session.emailCodeVerifiedAt),
});

const notFound = () =>
  new AppError(AppErrorCode.NOT_FOUND, {
    message: 'This in-person signing session has ended.',
  });

const wrongPhase = () =>
  new AppError(AppErrorCode.INVALID_REQUEST, {
    message: 'This step is no longer available. Reload the page.',
  });

const getRecipientBlockReason = (
  envelope: Pick<LoadedSession['envelope'], 'authOptions'>,
  recipient: Recipient,
  host: InPersonHost,
) => {
  const { derivedRecipientAccessAuth, derivedRecipientActionAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  return getInPersonSignerBlockReason({
    recipient,
    accessAuth: derivedRecipientAccessAuth,
    actionAuth: derivedRecipientActionAuth,
    hostEmail: host.email,
  });
};

export type StartInPersonSessionOptions = InPersonDevice & {
  envelopeId: string;
  pin: string;
  emailCodeRecipientIds: number[];
};

/**
 * Start hosting signers on this device. The caller has checked that the host may
 * see the envelope. The host's sign-in is locked until the session ends.
 */
export const startInPersonSession = async ({
  envelopeId,
  host,
  authSessionId,
  requestMetadata,
  pin,
  emailCodeRecipientIds,
}: StartInPersonSessionOptions) => {
  const envelope = await prisma.envelope.findFirst({
    where: { id: envelopeId, type: EnvelopeType.DOCUMENT },
    include: { recipients: true, documentMeta: true },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Document not found' });
  }

  const settings = await getTeamSettings({ teamId: envelope.teamId });

  const blockReason = getInPersonEnvelopeBlockReason({
    envelope,
    allowInPersonSigning: settings.allowInPersonSigning,
  });

  if (blockReason) {
    throw new AppError(
      blockReason === 'NOT_ALLOWED_BY_SETTINGS' ? AppErrorCode.FORBIDDEN : AppErrorCode.INVALID_REQUEST,
      { message: IN_PERSON_ENVELOPE_BLOCK_MESSAGES[blockReason] },
    );
  }

  if (!isValidInPersonPin(pin)) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'The PIN must be 4 to 8 digits.' });
  }

  const signerIds = new Set(
    envelope.recipients.filter((recipient) => recipient.role !== RecipientRole.CC).map((recipient) => recipient.id),
  );

  if (emailCodeRecipientIds.some((id) => !signerIds.has(id))) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Unknown recipient.' });
  }

  const canAnyoneSign = getInPersonTurnRecipients(envelope.recipients, envelope.documentMeta.signingOrder).some(
    (recipient) =>
      !getRecipientBlockReason(envelope, recipient, host) && recipient.signingStatus === SigningStatus.NOT_SIGNED,
  );

  if (!canAnyoneSign) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Nobody whose turn it is can sign in person right now.',
    });
  }

  // One session per sign-in: a new one replaces any other this browser was running.
  const previousSessions = await prisma.inPersonSigningSession.findMany({
    where: { authSessionId, endedAt: null },
  });

  for (const previous of previousSessions) {
    await endSession({ session: previous, host, reason: 'REPLACED', requestMetadata });
  }

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.inPersonSigningSession.create({
      data: {
        envelopeId: envelope.id,
        hostUserId: host.id,
        authSessionId,
        exitPinHash: hashSync(pin),
        emailCodeRecipientIds: [...new Set(emailCodeRecipientIds)],
        expiresAt: new Date(Date.now() + IN_PERSON_SESSION_LIFETIME_MS),
      },
    });

    await tx.session.update({
      where: { id: authSessionId },
      data: { stInPersonSessionId: created.id },
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.IN_PERSON_SESSION_STARTED,
        envelopeId: envelope.id,
        user: hostAuditUser(host),
        requestMetadata,
        data: {
          sessionId: created.id,
          hostUserId: host.id,
          hostName: host.name ?? '',
          hostEmail: host.email,
          emailCodeRecipientIds: created.emailCodeRecipientIds,
        },
      }),
    });

    return created;
  });

  return { sessionId: session.id };
};

/**
 * Load a session for the device that runs it. Any other browser, user or ended
 * session gets NOT_FOUND.
 */
const loadSessionForDevice = async ({ sessionId, device }: { sessionId: string; device: InPersonDevice }) => {
  const session = await prisma.inPersonSigningSession.findFirst({
    where: { id: sessionId, authSessionId: device.authSessionId, hostUserId: device.host.id },
    include: SESSION_INCLUDE,
  });

  if (!session || session.endedAt) {
    throw notFound();
  }

  if (!isActive(session)) {
    await endSession({ session, host: device.host, reason: 'EXPIRED', requestMetadata: device.requestMetadata });

    throw notFound();
  }

  return session;
};

type TurnOutcome = 'SIGNED' | 'REJECTED' | 'STOPPED' | 'REASSIGNED';

/**
 * A turn is void once the recipient acted (here or through their own link),
 * was reassigned (new token), or was removed. The device then locks.
 */
const settleTurn = async (session: LoadedSession): Promise<LoadedSession> => {
  if (session.phase !== InPersonSigningPhase.HANDOVER && session.phase !== InPersonSigningPhase.SIGNER) {
    return session;
  }

  const recipient = session.envelope.recipients.find((r) => r.id === session.recipientId);

  const isStillOpen =
    recipient &&
    recipient.token === session.recipientToken &&
    recipient.signingStatus === SigningStatus.NOT_SIGNED &&
    !session.envelope.deletedAt;

  if (isStillOpen) {
    return session;
  }

  await prisma.inPersonSigningSession.updateMany({
    where: { id: session.id, phase: session.phase, recipientId: session.recipientId },
    data: { phase: InPersonSigningPhase.HANDBACK, ...CLEARED_TURN_TOKEN },
  });

  return { ...session, phase: InPersonSigningPhase.HANDBACK, ...CLEARED_TURN_TOKEN };
};

const getTurnOutcome = (session: LoadedSession): TurnOutcome => {
  const recipient = session.envelope.recipients.find((r) => r.id === session.recipientId);

  if (!recipient || recipient.token !== session.recipientToken) {
    return 'REASSIGNED';
  }

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    return 'SIGNED';
  }

  if (recipient.signingStatus === SigningStatus.REJECTED) {
    return 'REJECTED';
  }

  return 'STOPPED';
};

const maskEmail = (email: string) => {
  const [local, domain] = email.split('@');

  if (!domain) {
    return email;
  }

  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
};

export type InPersonView =
  | {
      phase: 'HOST';
      sessionId: string;
      envelopeTitle: string;
      documentPath: string;
      isEnvelopePending: boolean;
      signers: {
        recipientId: number;
        name: string;
        email: string;
        role: Recipient['role'];
        signingStatus: Recipient['signingStatus'];
        isTheirTurn: boolean;
        blockReason: InPersonSignerBlockReason | null;
        blockMessage: string | null;
        requiresEmailCode: boolean;
      }[];
    }
  | {
      phase: 'HANDOVER';
      sessionId: string;
      envelopeTitle: string;
      recipientName: string;
      recipientRole: Recipient['role'];
      requiresEmailCode: boolean;
      isNameConfirmed: boolean;
      emailCodeSentTo: string | null;
    }
  | {
      phase: 'SIGNER';
      sessionId: string;
      envelopeTitle: string;
      recipientName: string;
    }
  | {
      phase: 'HANDBACK';
      sessionId: string;
      envelopeTitle: string;
      hostName: string;
      recipientName: string | null;
      outcome: TurnOutcome | null;
    };

/**
 * What the in-person screen shows. No recipient link token leaves the server.
 */
export const getInPersonView = async ({
  sessionId,
  device,
}: {
  sessionId: string;
  device: InPersonDevice;
}): Promise<InPersonView> => {
  const session = await settleTurn(await loadSessionForDevice({ sessionId, device }));
  const { envelope } = session;

  const recipient = envelope.recipients.find((r) => r.id === session.recipientId) ?? null;

  if (session.phase === InPersonSigningPhase.HANDOVER && recipient) {
    return {
      phase: 'HANDOVER',
      sessionId: session.id,
      envelopeTitle: envelope.title,
      recipientName: recipient.name || recipient.email,
      recipientRole: recipient.role,
      requiresEmailCode: session.emailCodeRecipientIds.includes(recipient.id),
      isNameConfirmed: Boolean(session.confirmedName),
      emailCodeSentTo: session.emailCodeSentAt ? maskEmail(recipient.email) : null,
    };
  }

  if (session.phase === InPersonSigningPhase.SIGNER && recipient) {
    return {
      phase: 'SIGNER',
      sessionId: session.id,
      envelopeTitle: envelope.title,
      recipientName: recipient.name || recipient.email,
    };
  }

  if (session.phase === InPersonSigningPhase.HANDBACK) {
    return {
      phase: 'HANDBACK',
      sessionId: session.id,
      envelopeTitle: envelope.title,
      hostName: device.host.name || device.host.email,
      recipientName: recipient ? recipient.name || recipient.email : null,
      outcome: session.recipientId ? getTurnOutcome(session) : null,
    };
  }

  const turnIds = new Set(
    getInPersonTurnRecipients(envelope.recipients, envelope.documentMeta.signingOrder).map((r) => r.id),
  );

  const isEnvelopePending = !getInPersonEnvelopeBlockReason({ envelope, allowInPersonSigning: true });

  return {
    phase: 'HOST',
    sessionId: session.id,
    envelopeTitle: envelope.title,
    documentPath: `${formatDocumentsPath(envelope.team.url)}/${envelope.id}`,
    isEnvelopePending,
    signers: envelope.recipients
      .filter((r) => r.role !== RecipientRole.CC)
      .map((r) => {
        const blockReason = getRecipientBlockReason(envelope, r, device.host);

        return {
          recipientId: r.id,
          name: r.name,
          email: r.email,
          role: r.role,
          signingStatus: r.signingStatus,
          isTheirTurn: isEnvelopePending && turnIds.has(r.id),
          blockReason,
          blockMessage: blockReason ? IN_PERSON_SIGNER_BLOCK_MESSAGES[blockReason] : null,
          requiresEmailCode: session.emailCodeRecipientIds.includes(r.id),
        };
      }),
  };
};

/**
 * The host picks the signer and hands over the device.
 */
export const beginInPersonHandover = async ({
  sessionId,
  device,
  recipientId,
}: {
  sessionId: string;
  device: InPersonDevice;
  recipientId: number;
}) => {
  const session = await settleTurn(await loadSessionForDevice({ sessionId, device }));

  if (session.phase !== InPersonSigningPhase.HOST) {
    throw wrongPhase();
  }

  const { envelope } = session;

  const envelopeBlock = getInPersonEnvelopeBlockReason({ envelope, allowInPersonSigning: true });

  if (envelopeBlock) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: IN_PERSON_ENVELOPE_BLOCK_MESSAGES[envelopeBlock] });
  }

  const recipient = getInPersonTurnRecipients(envelope.recipients, envelope.documentMeta.signingOrder).find(
    (r) => r.id === recipientId,
  );

  if (!recipient) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'It is not this signer’s turn.' });
  }

  const blockReason = getRecipientBlockReason(envelope, recipient, device.host);

  if (blockReason) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: IN_PERSON_SIGNER_BLOCK_MESSAGES[blockReason] });
  }

  const { count } = await prisma.inPersonSigningSession.updateMany({
    where: { id: session.id, phase: InPersonSigningPhase.HOST, endedAt: null },
    data: {
      phase: InPersonSigningPhase.HANDOVER,
      recipientId: recipient.id,
      recipientToken: recipient.token,
      confirmedName: null,
      emailCodeSentAt: null,
      emailCodeVerifiedAt: null,
      turnStartedAt: null,
      ...CLEARED_TURN_TOKEN,
    },
  });

  if (count !== 1) {
    throw wrongPhase();
  }
};

const loadHandover = async ({ sessionId, device }: { sessionId: string; device: InPersonDevice }) => {
  const session = await settleTurn(await loadSessionForDevice({ sessionId, device }));

  const recipient = session.envelope.recipients.find((r) => r.id === session.recipientId);

  if (session.phase !== InPersonSigningPhase.HANDOVER || !recipient) {
    throw wrongPhase();
  }

  return { session, recipient };
};

/**
 * Write the "signer started" evidence and open the signing page for them.
 */
const startTurn = async ({
  session,
  recipient,
  device,
  confirmedName,
  emailCodeVerified,
}: {
  session: LoadedSession;
  recipient: Recipient;
  device: InPersonDevice;
  confirmedName: string;
  emailCodeVerified: boolean;
}) => {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.inPersonSigningSession.updateMany({
      where: {
        id: session.id,
        phase: InPersonSigningPhase.HANDOVER,
        recipientId: recipient.id,
        recipientToken: recipient.token,
        endedAt: null,
      },
      data: {
        phase: InPersonSigningPhase.SIGNER,
        confirmedName,
        turnStartedAt: now,
        emailCodeVerifiedAt: emailCodeVerified ? now : null,
        turnToken: createInPersonTurnToken(),
        turnTokenExpiresAt: getInPersonTurnTokenExpiry(session.expiresAt, now),
      },
    });

    if (count !== 1) {
      throw wrongPhase();
    }

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.IN_PERSON_SIGNER_STARTED,
        envelopeId: session.envelopeId,
        user: { name: recipient.name, email: recipient.email },
        requestMetadata: device.requestMetadata,
        data: {
          ...toHostMarker({ ...session, emailCodeVerifiedAt: emailCodeVerified ? now : null }, device.host),
          recipientId: recipient.id,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
          recipientRole: recipient.role,
          confirmedName,
        },
      }),
    });
  });
};

/**
 * The signer types their name. When the host asked for an email code, the code
 * is sent now and the turn starts after it is entered.
 */
export const confirmInPersonSigner = async ({
  sessionId,
  device,
  typedName,
}: {
  sessionId: string;
  device: InPersonDevice;
  typedName: string;
}) => {
  const { session, recipient } = await loadHandover({ sessionId, device });

  if (!isInPersonNameConfirmed({ expected: recipient.name, typed: typedName })) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: recipient.name ? 'The name does not match the name on the document.' : 'Enter your full name.',
    });
  }

  const confirmedName = typedName.trim().replace(/\s+/g, ' ');

  if (!session.emailCodeRecipientIds.includes(recipient.id)) {
    await startTurn({ session, recipient, device, confirmedName, emailCodeVerified: false });

    return { needsEmailCode: false };
  }

  await prisma.inPersonSigningSession.update({
    where: { id: session.id },
    data: { confirmedName },
  });

  await sendInPersonEmailCode({ sessionId, device });

  return { needsEmailCode: true };
};

export const sendInPersonEmailCode = async ({ sessionId, device }: { sessionId: string; device: InPersonDevice }) => {
  const { session, recipient } = await loadHandover({ sessionId, device });

  if (!session.confirmedName || !session.emailCodeRecipientIds.includes(recipient.id)) {
    throw wrongPhase();
  }

  await send2FATokenEmail({ token: recipient.token, envelopeId: session.envelopeId });

  await prisma.inPersonSigningSession.update({
    where: { id: session.id },
    data: { emailCodeSentAt: new Date() },
  });
};

export const verifyInPersonEmailCode = async ({
  sessionId,
  device,
  code,
}: {
  sessionId: string;
  device: InPersonDevice;
  code: string;
}) => {
  const { session, recipient } = await loadHandover({ sessionId, device });

  if (!session.confirmedName || !session.emailCodeSentAt || !session.emailCodeRecipientIds.includes(recipient.id)) {
    throw wrongPhase();
  }

  // Solid Ten Sign (AUD-1): the same attempt limit as on the signing link.
  const isValid = await checkEmailAccessCodeWithLimit({
    recipient: { id: recipient.id, envelopeId: session.envelopeId, email: recipient.email, name: recipient.name },
    code: code.trim(),
    requestMetadata: device.requestMetadata,
  });

  if (!isValid) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'The code is not correct or has expired.' });
  }

  await startTurn({ session, recipient, device, confirmedName: session.confirmedName, emailCodeVerified: true });
};

/**
 * The signer stops (or says "this is not me"). The device locks until the host
 * enters the PIN.
 */
export const stopInPersonTurn = async ({ sessionId, device }: { sessionId: string; device: InPersonDevice }) => {
  const session = await settleTurn(await loadSessionForDevice({ sessionId, device }));

  if (session.phase === InPersonSigningPhase.HANDBACK) {
    return;
  }

  if (session.phase === InPersonSigningPhase.HOST) {
    throw wrongPhase();
  }

  await prisma.inPersonSigningSession.updateMany({
    where: { id: session.id, phase: session.phase, endedAt: null },
    data: { phase: InPersonSigningPhase.HANDBACK, ...CLEARED_TURN_TOKEN },
  });
};

/**
 * Check the host's PIN. Too many wrong PINs end the session and sign the
 * device out, so a signer cannot guess their way into the host's account.
 */
const checkPin = async ({ session, device, pin }: { session: LoadedSession; device: InPersonDevice; pin: string }) => {
  if (isValidInPersonPin(pin) && compareSync(pin, session.exitPinHash)) {
    await prisma.inPersonSigningSession.update({
      where: { id: session.id },
      data: { failedPinAttempts: 0 },
    });

    return;
  }

  const updated = await prisma.inPersonSigningSession.update({
    where: { id: session.id },
    data: { failedPinAttempts: { increment: 1 } },
  });

  if (updated.failedPinAttempts >= IN_PERSON_MAX_PIN_ATTEMPTS) {
    await endSession({ session, host: device.host, reason: 'PIN_LOCKOUT', requestMetadata: device.requestMetadata });

    await prisma.session.deleteMany({ where: { id: device.authSessionId } });

    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Too many wrong PINs. In-person signing ended and this device was signed out.',
    });
  }

  throw new AppError(AppErrorCode.INVALID_BODY, {
    message: `The PIN is not correct. ${IN_PERSON_MAX_PIN_ATTEMPTS - updated.failedPinAttempts} attempts left.`,
  });
};

/**
 * The host takes the device back after a signer.
 */
export const unlockInPersonSession = async ({
  sessionId,
  device,
  pin,
}: {
  sessionId: string;
  device: InPersonDevice;
  pin: string;
}) => {
  const session = await settleTurn(await loadSessionForDevice({ sessionId, device }));

  if (session.phase !== InPersonSigningPhase.HANDBACK) {
    throw wrongPhase();
  }

  await checkPin({ session, device, pin });

  await prisma.inPersonSigningSession.updateMany({
    where: { id: session.id, phase: InPersonSigningPhase.HANDBACK, endedAt: null },
    data: {
      phase: InPersonSigningPhase.HOST,
      recipientId: null,
      recipientToken: null,
      confirmedName: null,
      emailCodeSentAt: null,
      emailCodeVerifiedAt: null,
      turnStartedAt: null,
      ...CLEARED_TURN_TOKEN,
    },
  });
};

/**
 * Leave in-person mode. Always needs the PIN, from any screen.
 */
export const exitInPersonSession = async ({
  sessionId,
  device,
  pin,
}: {
  sessionId: string;
  device: InPersonDevice;
  pin: string;
}) => {
  const session = await loadSessionForDevice({ sessionId, device });

  await checkPin({ session, device, pin });

  await endSession({ session, host: device.host, reason: 'EXITED', requestMetadata: device.requestMetadata });

  return { documentPath: `${formatDocumentsPath(session.envelope.team.url)}/${session.envelope.id}` };
};

/**
 * End every running session for an envelope from another browser, for a host
 * who forgot the PIN or left the device behind. The caller has checked that the
 * actor can see the envelope.
 *
 * Solid Ten Sign: the host rule applies (owner, team admin or manager); anyone
 * else may end only sessions they host themselves. The audit entry names the actor.
 */
export const endInPersonSessionsForEnvelope = async ({
  envelopeId,
  actor,
  requestMetadata,
}: {
  envelopeId: string;
  actor: InPersonHost;
  requestMetadata?: RequestMetadata;
}) => {
  const sessions = await prisma.inPersonSigningSession.findMany({
    where: { envelopeId, endedAt: null },
  });

  const mayHost = await canHostInPerson({ envelopeId, userId: actor.id });
  const allowed = mayHost ? sessions : sessions.filter((session) => session.hostUserId === actor.id);

  if (sessions.length > 0 && allowed.length === 0) {
    throw new AppError(AppErrorCode.FORBIDDEN, { message: IN_PERSON_NOT_HOST_MESSAGE });
  }

  for (const session of allowed) {
    await endSession({
      session,
      host: await getHost(session.hostUserId),
      actor,
      reason: 'ENDED_ELSEWHERE',
      requestMetadata,
    });
  }

  return { endedCount: allowed.length, endedBy: actor.id };
};

export const findActiveInPersonSessionsForEnvelope = async ({ envelopeId }: { envelopeId: string }) => {
  const sessions = await prisma.inPersonSigningSession.findMany({
    where: { envelopeId, endedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, hostUserId: true, createdAt: true },
  });

  const hosts = await prisma.user.findMany({
    where: { id: { in: sessions.map((s) => s.hostUserId) } },
    select: { id: true, name: true, email: true },
  });

  return sessions.map((s) => {
    const host = hosts.find((h) => h.id === s.hostUserId);

    return { id: s.id, hostName: host?.name || host?.email || '', startedAt: s.createdAt };
  });
};

/**
 * The tokens for the signer whose turn it is, for the in-person signing page.
 * `token` (the recipient's link token) is for server-side use only. The page
 * gets `turnToken`, which works only from this sign-in and only for this turn.
 */
export const getInPersonSigningToken = async ({ sessionId, device }: { sessionId: string; device: InPersonDevice }) => {
  const session = await settleTurn(await loadSessionForDevice({ sessionId, device }));

  if (
    session.phase !== InPersonSigningPhase.SIGNER ||
    !session.recipientToken ||
    !session.turnToken ||
    !session.turnTokenExpiresAt ||
    session.turnTokenExpiresAt <= new Date()
  ) {
    return null;
  }

  return { token: session.recipientToken, turnToken: session.turnToken };
};

/**
 * Whether this request is an in-person signer acting on the host's device: the
 * request carries the locked sign-in, and the token is the current turn's.
 * Returns the host marker for the recipient's audit entries.
 */
export const findInPersonHostForRequest = async ({
  authSessionId,
  token,
}: {
  authSessionId?: string | null;
  token: string;
}): Promise<TInPersonHostMarker | null> => {
  if (!authSessionId) {
    return null;
  }

  const session = await prisma.inPersonSigningSession.findFirst({
    where: {
      authSessionId,
      recipientToken: token,
      phase: InPersonSigningPhase.SIGNER,
      endedAt: null,
      expiresAt: { gt: new Date() },
    },
  });

  if (!session) {
    return null;
  }

  return toHostMarker(session, await getHost(session.hostUserId));
};

/**
 * What the "Sign in person" dialog offers on the document page. The caller has
 * checked that the user may see the envelope.
 */
export const getInPersonOptions = async ({ envelopeId, host }: { envelopeId: string; host: InPersonHost }) => {
  const envelope = await prisma.envelope.findFirstOrThrow({
    where: { id: envelopeId, type: EnvelopeType.DOCUMENT },
    include: { recipients: { orderBy: [{ signingOrder: 'asc' }, { id: 'asc' }] }, documentMeta: true },
  });

  const settings = await getTeamSettings({ teamId: envelope.teamId });

  const blockReason = getInPersonEnvelopeBlockReason({
    envelope,
    allowInPersonSigning: settings.allowInPersonSigning,
  });

  const turnIds = new Set(
    getInPersonTurnRecipients(envelope.recipients, envelope.documentMeta.signingOrder).map((r) => r.id),
  );

  const signers = envelope.recipients
    .filter((r) => r.role !== RecipientRole.CC && r.signingStatus === SigningStatus.NOT_SIGNED)
    .map((r) => {
      const signerBlock = getRecipientBlockReason(envelope, r, host);

      return {
        recipientId: r.id,
        name: r.name,
        email: r.email,
        isTheirTurn: turnIds.has(r.id),
        blockMessage: signerBlock ? IN_PERSON_SIGNER_BLOCK_MESSAGES[signerBlock] : null,
      };
    });

  return {
    isAvailable: !blockReason,
    unavailableReason: blockReason ? IN_PERSON_ENVELOPE_BLOCK_MESSAGES[blockReason] : null,
    signers,
    activeSessions: await findActiveInPersonSessionsForEnvelope({ envelopeId }),
  };
};

/**
 * Solid Ten Sign (RT2-L3): after the signer completes or declines on the device, the turn
 * ends at once: the device locks to "hand back" and the turn credential is cleared, in the
 * same request. Safe to call when the turn already ended.
 */
export const endInPersonTurnAfterSignerAction = async ({ sessionId }: { sessionId: string }) => {
  await prisma.inPersonSigningSession.updateMany({
    where: { id: sessionId, phase: InPersonSigningPhase.SIGNER, endedAt: null },
    data: { phase: InPersonSigningPhase.HANDBACK, ...CLEARED_TURN_TOKEN },
  });
};
