import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { getRecipientReassignBlockReason } from '../../utils/recipient-reassign';
import { getTeamSettings } from '../team/get-team-settings';

/**
 * Whether the signing page should offer "Reassign" to the holder of this link.
 * The reassign route checks everything again; this only decides what to show.
 */
export const getSignerReassignOptions = async ({ token }: { token: string }) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token, envelope: { type: EnvelopeType.DOCUMENT } },
    include: { envelope: true },
  });

  if (!recipient) {
    return { canReassign: false };
  }

  const settings = await getTeamSettings({ teamId: recipient.envelope.teamId });

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: recipient.envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  const blockReason = getRecipientReassignBlockReason({
    actor: 'SIGNER',
    envelope: recipient.envelope,
    recipient,
    settings,
    accessAuthMethods: derivedRecipientAccessAuth,
    now: new Date(),
  });

  return { canReassign: blockReason === null };
};
