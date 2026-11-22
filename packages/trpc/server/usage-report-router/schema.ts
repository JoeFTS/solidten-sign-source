import { DocumentStatus } from '@prisma/client';
import { z } from 'zod';

import {
  ZAnalyticsRangeFieldsSchema,
  ZTeamAnalyticsRequestSchema,
  ZTeamAnalyticsResolvedRangeSchema,
} from '../team-router/get-team-analytics.types';

export const ZGetTeamUsageReportRequestSchema = ZTeamAnalyticsRequestSchema;

export const ZGetOrganisationUsageReportRequestSchema = ZAnalyticsRangeFieldsSchema.extend({
  organisationId: z.string().min(1),
});

const ZCountSchema = z.number().int().nonnegative();

const ZUsageSummarySchema = z.object({
  sent: ZCountSchema,
  completed: ZCountSchema,
  declined: ZCountSchema,
  cancelled: ZCountSchema,
  expired: ZCountSchema,
  pending: ZCountSchema,
  completionRate: z.number().min(0).max(100).nullable(),
  timeToComplete: z.object({
    count: ZCountSchema,
    averageMs: z.number().nonnegative().nullable(),
    medianMs: z.number().nonnegative().nullable(),
  }),
});

export const ZUsageReportResponseSchema = z.object({
  range: ZTeamAnalyticsResolvedRangeSchema,
  isTruncated: z.boolean(),
  summary: ZUsageSummarySchema,
  members: ZUsageSummarySchema.extend({
    userId: z.number(),
    name: z.string().nullable(),
    email: z.string(),
  }).array(),
});

export const ZUsageReportDocumentsResponseSchema = z.object({
  range: ZTeamAnalyticsResolvedRangeSchema,
  isTruncated: z.boolean(),
  documents: z
    .object({
      envelopeId: z.string(),
      documentId: z.number(),
      title: z.string(),
      status: z.nativeEnum(DocumentStatus),
      ownerUserId: z.number(),
      ownerName: z.string().nullable(),
      ownerEmail: z.string(),
      teamId: z.number(),
      teamName: z.string(),
      sentAt: z.date(),
      completedAt: z.date().nullable(),
      isExpired: z.boolean(),
      recipientCount: ZCountSchema,
    })
    .array(),
});
