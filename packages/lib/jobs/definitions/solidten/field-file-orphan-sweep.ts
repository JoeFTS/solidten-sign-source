import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION_ID = 'internal.field-file-orphan-sweep';

const FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION_SCHEMA = z.object({});

export type TFieldFileOrphanSweepJobDefinition = z.infer<typeof FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION_SCHEMA>;

/**
 * Solid Ten Sign (S-M5): daily removal of attached-file content nothing references.
 */
export const FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION = {
  id: FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION_ID,
  name: 'Attached File Orphan Sweep',
  version: '1.0.0',
  trigger: {
    name: FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION_ID,
    schema: FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION_SCHEMA,
    cron: '45 3 * * *',
  },
  handler: async ({ io }) => {
    const { sweepOrphanFieldFileContents } = await import(
      '../../../server-only/field-file/sweep-orphan-field-file-contents'
    );

    const { found, deleted } = await sweepOrphanFieldFileContents();

    io.logger.info(`Unreferenced attached files: ${found} found, ${deleted} removed`);
  },
} as const satisfies JobDefinition<
  typeof FIELD_FILE_ORPHAN_SWEEP_JOB_DEFINITION_ID,
  TFieldFileOrphanSweepJobDefinition
>;
