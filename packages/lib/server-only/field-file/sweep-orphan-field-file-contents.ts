import { prisma } from '@documenso/prisma';

import { DataContentType } from '../../types/data-content-meta';
import { logger } from '../../utils/logger';
import { isRetentionDryRun } from '../retention/retention-rules';
import { deleteStoredFieldFile } from './remove-field-files-in-transaction';

const SWEEP_BATCH_SIZE = 500;

/**
 * Solid Ten Sign (S-M5): stored content of attached files that nothing references any
 * more, for example after an envelope, recipient or field was deleted with object
 * storage. Database-stored content is removed by a trigger when the upload row goes;
 * this catches the rest. An upload creates its content and its row in one transaction,
 * so content without a row is never an upload in progress.
 *
 * NEXT_PRIVATE_RETENTION_DRY_RUN=true logs what would be removed and changes nothing.
 */
export const sweepOrphanFieldFileContents = async ({ dryRun = isRetentionDryRun() }: { dryRun?: boolean } = {}) => {
  const orphans = await prisma.dataContent.findMany({
    where: {
      fieldFileUpload: null,
      envelopeContents: { none: {} },
      metadata: { path: ['type'], equals: DataContentType.FILE },
    },
    select: { id: true, type: true, data: true },
    take: SWEEP_BATCH_SIZE,
  });

  if (dryRun) {
    if (orphans.length > 0) {
      logger.info({ msg: `[FIELD_FILE] Dry run: ${orphans.length} unreferenced attached files would be removed` });
    }

    return { found: orphans.length, deleted: 0 };
  }

  let deleted = 0;

  for (const orphan of orphans) {
    // The object first: a crash leaves a row to find again, never an object nobody can find.
    await deleteStoredFieldFile(orphan);

    const { count } = await prisma.dataContent.deleteMany({
      where: { id: orphan.id, fieldFileUpload: null, envelopeContents: { none: {} } },
    });

    deleted += count;
  }

  if (deleted > 0) {
    logger.info({ msg: `[FIELD_FILE] Removed ${deleted} unreferenced attached files` });
  }

  return { found: orphans.length, deleted };
};
