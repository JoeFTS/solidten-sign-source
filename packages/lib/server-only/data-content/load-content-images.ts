import { prisma } from '@documenso/prisma';
import { Image as SkiaImage } from '@documenso/skia-canvas';
import type { EnvelopeContent } from '@prisma/client';
import pMap from 'p-map';

import { DataContentType } from '../../types/data-content-meta';
import type { ContentImageMap, ContentImageSource } from '../../universal/content-renderer/content-renderer';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { getDataContentIds } from '../../utils/envelope-content';

export const loadContentImages = async (contents: Pick<EnvelopeContent, 'dataContentId'>[]): Promise<ContentImageMap> =>
  new Map(
    [...(await loadContentImageBytes(contents))].map(
      ([id, bytes]) => [id, new SkiaImage(Buffer.from(bytes)) as unknown as ContentImageSource] as const,
    ),
  );

/**
 * Solid Ten: the stored bytes of the content images, by data content id, not yet decoded (the PDF
 * child decodes them; it has no database, SEC3-M1).
 */
export const loadContentImageBytes = async (
  contents: Pick<EnvelopeContent, 'dataContentId'>[],
): Promise<Map<string, Uint8Array>> => {
  const dataContentIds = getDataContentIds(contents);

  if (dataContentIds.length === 0) {
    return new Map();
  }

  const dataContents = await prisma.dataContent.findMany({
    where: {
      id: {
        in: dataContentIds,
      },
    },
  });

  const entries = await pMap(
    dataContents,
    async (dataContent): Promise<[string, Uint8Array] | null> => {
      if (dataContent.metadata.type !== DataContentType.IMAGE) {
        return null;
      }

      const bytes = await getFileServerSide({
        type: dataContent.type,
        data: dataContent.data,
      });

      return [dataContent.id, bytes];
    },
    { concurrency: 6 },
  );

  return new Map(entries.filter((entry) => entry !== null));
};
