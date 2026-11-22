import { DocumentDataType, DocumentStatus, EnvelopeType } from '@prisma/client';

import {
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type TRetentionSettings,
  ZRetentionSettingsSchema,
} from '../types/retention-settings';

export { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, type TRetentionSettings, ZRetentionSettingsSchema };

export const DEFAULT_RETENTION_SETTINGS: TRetentionSettings = {
  enabled: false,
  action: 'SOFT_DELETE',
  days: 365,
  includeRejected: false,
  includeCancelled: false,
};

/**
 * Read a stored retention rule. Anything missing or malformed counts as "off",
 * so a bad row can never widen what gets deleted.
 */
export const parseRetentionSettings = (value: unknown): TRetentionSettings | null => {
  const parsed = ZRetentionSettingsSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
};

/**
 * The rule that applies to a team: the team's own value when it has one
 * (including a disabled one), otherwise the organisation's.
 */
export const resolveRetentionSettings = ({
  organisationValue,
  teamValue,
}: {
  organisationValue: unknown;
  teamValue: unknown;
}): TRetentionSettings | null => {
  const settings = teamValue !== null && teamValue !== undefined ? teamValue : organisationValue;

  const parsed = parseRetentionSettings(settings);

  return parsed?.enabled ? parsed : null;
};

export const getRetentionStatuses = (settings: TRetentionSettings): DocumentStatus[] => {
  const statuses: DocumentStatus[] = [DocumentStatus.COMPLETED];

  if (settings.includeRejected) {
    statuses.push(DocumentStatus.REJECTED);
  }

  if (settings.includeCancelled) {
    statuses.push(DocumentStatus.CANCELLED);
  }

  return statuses;
};

/**
 * Documents that finished at or before this instant are due. A document that
 * finished exactly `days` days ago is due.
 */
export const getRetentionCutoff = (settings: TRetentionSettings, now: Date) =>
  new Date(now.getTime() - settings.days * 24 * 60 * 60 * 1000);

export type RetentionEnvelopeSnapshot = {
  type: EnvelopeType;
  status: DocumentStatus;
  completedAt: Date | null;
  deletedAt: Date | null;
};

/**
 * Whether the rule applies to this envelope now. Drafts, pending documents and
 * templates are never eligible, whatever the rule says.
 */
export const isEnvelopeRetentionEligible = ({
  envelope,
  settings,
  now,
}: {
  envelope: RetentionEnvelopeSnapshot;
  settings: TRetentionSettings | null;
  now: Date;
}) => {
  if (!settings?.enabled) {
    return false;
  }

  if (envelope.type !== EnvelopeType.DOCUMENT) {
    return false;
  }

  if (!getRetentionStatuses(settings).includes(envelope.status)) {
    return false;
  }

  if (!envelope.completedAt || envelope.completedAt.getTime() > getRetentionCutoff(settings, now).getTime()) {
    return false;
  }

  // A soft delete of an already deleted document would change nothing.
  if (settings.action === 'SOFT_DELETE' && envelope.deletedAt) {
    return false;
  }

  return true;
};

type StoredValue = { type: DocumentDataType; data: string; initialData: string };

/**
 * Which stored objects a purge may remove from object storage.
 *
 * `ownRows` are the stored-data rows being deleted. `valuesUsedElsewhere` are
 * the `data` / `initialData` values still held by rows that stay (for example
 * the template a document was created from). A value still used elsewhere is
 * kept. Inline (database) values are not objects and are never returned; they
 * go away with their rows.
 */
export const planStoredObjectDeletion = ({
  ownRows,
  valuesUsedElsewhere,
}: {
  ownRows: StoredValue[];
  valuesUsedElsewhere: Set<string>;
}) => {
  const objectKeys = new Set<string>();
  const keptKeys = new Set<string>();

  for (const row of ownRows) {
    if (row.type !== DocumentDataType.S3_PATH) {
      continue;
    }

    for (const key of [row.data, row.initialData]) {
      if (valuesUsedElsewhere.has(key)) {
        keptKeys.add(key);
      } else {
        objectKeys.add(key);
      }
    }
  }

  return { keysToDelete: [...objectKeys], keysKept: [...keptKeys] };
};
