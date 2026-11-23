import { prisma } from '@documenso/prisma';
import { DocumentStatus } from '@prisma/client';

import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { deleteDocument } from '../document/delete-document';

/**
 * Solid Ten Sign (A-2): "Use template" with "send" creates the document and then sends it. When
 * the send is refused (an invalid formula, a missing signature field, a limit), the document the
 * same request just created was left behind as a draft the user never asked for, and the error
 * did not mention it. Now it is removed again, through the normal delete (audit, permissions),
 * but only while it is still a DRAFT: a send that got further is never undone here.
 *
 * Never throws: the caller re-throws the send's own error, which is what the user must see.
 */
export const discardUnsentDraft = async ({
  envelopeId,
  userId,
  teamId,
  requestMetadata,
}: {
  envelopeId: string;
  userId: number;
  teamId: number;
  requestMetadata: ApiRequestMetadata;
}) => {
  try {
    const envelope = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });

    if (envelope?.status !== DocumentStatus.DRAFT) {
      return;
    }

    await deleteDocument({ id: { type: 'envelopeId', id: envelopeId }, userId, teamId, requestMetadata });
  } catch (error) {
    console.error(`[USE_TEMPLATE] Could not remove the unsent draft ${envelopeId}`, error);
  }
};
