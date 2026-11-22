import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getInPersonLockId } from '@documenso/lib/server-only/in-person/in-person-lock';
import { DocumentAccessAuth } from '@documenso/lib/types/document-auth';
import { extractDocumentAuthMethods } from '@documenso/lib/utils/document-auth';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';
import type { Context } from 'hono';
import { match } from 'ts-pattern';

/**
 * Solid Ten (LD3-M2): the document bytes are fetched by URL with the recipient's token, so the
 * token routes must apply the same access check as the signing page: a recipient whose
 * access needs a signed-in account gets nothing until that account is signed in.
 *
 * An embed session counts (embedded signing signs the recipient in that way); a sign-in
 * locked for in-person signing does not, so the host's account can never satisfy it.
 * QR tokens belong to a completed document's share link: no recipient check, but the document must
 * be completed and not deleted.
 */
export const canTokenAccessDocument = async (
  c: Context,
  { token, envelopeId }: { token: string; envelopeId: string },
) => {
  // Solid Ten (AUD-13): a qr_ token is the share link of a completed document. It opens files only
  // of that envelope once it is COMPLETED and not deleted, as the share page requires.
  if (token.startsWith('qr_')) {
    const shared = await prisma.envelope.count({
      where: { id: envelopeId, qrToken: token, status: DocumentStatus.COMPLETED, deletedAt: null },
    });

    return shared > 0;
  }

  const recipient = await prisma.recipient.findFirst({
    where: { token, envelopeId },
    select: {
      id: true,
      email: true,
      envelopeId: true,
      authOptions: true,
      envelope: {
        select: {
          authOptions: true,
          type: true,
          directLink: { select: { enabled: true, directTemplateRecipientId: true } },
        },
      },
    },
  });

  if (!recipient) {
    return false;
  }

  const { session, user } = await getOptionalSession(c);
  const isLocked = session ? Boolean(await getInPersonLockId(session)) : false;

  // Solid Ten: the placeholder recipient of an enabled direct link stands for "whoever opens the
  // link", so no account has its address. The direct-link page (`d.$token`) therefore accepts ANY
  // signed-in account for ACCOUNT access. The file routes must use the same rule, or the page passes
  // its gate and then cannot load the PDF (the upstream "direct template link auth access" tests
  // failed with "Something went wrong while loading the document" since the token PDF routes began
  // to check access, LD3-M2).
  const isDirectTemplateRecipient =
    recipient.envelope.type === EnvelopeType.TEMPLATE &&
    recipient.envelope.directLink?.enabled === true &&
    recipient.envelope.directLink.directTemplateRecipientId === recipient.id;

  if (isDirectTemplateRecipient) {
    const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
      documentAuth: recipient.envelope.authOptions,
    });

    return derivedRecipientAccessAuth.every((auth) =>
      match(auth)
        .with(DocumentAccessAuth.ACCOUNT, () => Boolean(user) && !isLocked)
        .with(DocumentAccessAuth.TWO_FACTOR_AUTH, () => true)
        .exhaustive(),
    );
  }

  return await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: recipient.envelope.authOptions,
    recipient,
    userId: user && !isLocked ? user.id : undefined,
  });
};
