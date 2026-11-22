import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { mapSecondaryIdToDocumentId } from '../../utils/envelope';

export type GetDocumentByAccessTokenOptions = {
  token: string;
};

export const getDocumentByAccessToken = async ({ token }: GetDocumentByAccessTokenOptions) => {
  if (!token) {
    throw new Error('Missing token');
  }

  const result = await prisma.envelope.findFirst({
    where: {
      type: EnvelopeType.DOCUMENT,
      status: DocumentStatus.COMPLETED,
      qrToken: token,
      // Solid Ten (AUD-13 follow-up): a deleted document has no share page, as its qr_ file routes.
      deletedAt: null,
    },
    // Do not provide extra information that is not needed.
    select: {
      id: true,
      secondaryId: true,
      internalVersion: true,
      title: true,
      completedAt: true,
      team: {
        select: {
          url: true,
        },
      },
      envelopeItems: {
        select: {
          id: true,
          title: true,
          order: true,
          documentDataId: true,
          envelopeId: true,
          // Solid Ten (LD3-M2): never the bytes; the share page's viewer fetches the PDF by URL.
          documentData: {
            select: {
              id: true,
              type: true,
            },
          },
        },
      },
      _count: {
        select: {
          recipients: true,
        },
      },
    },
  });

  if (!result) {
    return null;
  }

  if (result.envelopeItems.length === 0) {
    throw new Error('Completed envelope has no items');
  }

  const firstDocumentData = result.envelopeItems[0].documentData;

  if (!firstDocumentData) {
    throw new Error('Missing document data');
  }

  return {
    id: mapSecondaryIdToDocumentId(result.secondaryId),
    internalVersion: result.internalVersion,
    title: result.title,
    completedAt: result.completedAt,
    envelopeItems: result.envelopeItems,
    recipientCount: result._count.recipients,
    documentTeamUrl: result.team.url,
  };
};
