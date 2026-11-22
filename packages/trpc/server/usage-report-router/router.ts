import {
  getOrganisationUsageReport,
  getOrganisationUsageReportDocuments,
  getTeamUsageReport,
  getTeamUsageReportDocuments,
} from '@documenso/lib/server-only/usage-report/get-usage-report';

import { authenticatedProcedure, router } from '../trpc';
import {
  ZGetOrganisationUsageReportRequestSchema,
  ZGetTeamUsageReportRequestSchema,
  ZUsageReportDocumentsResponseSchema,
  ZUsageReportResponseSchema,
} from './schema';

export const usageReportRouter = router({
  getTeam: authenticatedProcedure
    .input(ZGetTeamUsageReportRequestSchema)
    .output(ZUsageReportResponseSchema)
    .query(async ({ input, ctx }) => {
      ctx.logger.info({ input: { teamId: input.teamId, range: input.range } });

      return await getTeamUsageReport({ ...input, userId: ctx.user.id, userEmail: ctx.user.email });
    }),

  getTeamDocuments: authenticatedProcedure
    .input(ZGetTeamUsageReportRequestSchema)
    .output(ZUsageReportDocumentsResponseSchema)
    .query(async ({ input, ctx }) => {
      ctx.logger.info({ input: { teamId: input.teamId, range: input.range } });

      return await getTeamUsageReportDocuments({ ...input, userId: ctx.user.id, userEmail: ctx.user.email });
    }),

  getOrganisation: authenticatedProcedure
    .input(ZGetOrganisationUsageReportRequestSchema)
    .output(ZUsageReportResponseSchema)
    .query(async ({ input, ctx }) => {
      ctx.logger.info({ input: { organisationId: input.organisationId, range: input.range } });

      return await getOrganisationUsageReport({ ...input, userId: ctx.user.id });
    }),

  getOrganisationDocuments: authenticatedProcedure
    .input(ZGetOrganisationUsageReportRequestSchema)
    .output(ZUsageReportDocumentsResponseSchema)
    .query(async ({ input, ctx }) => {
      ctx.logger.info({ input: { organisationId: input.organisationId, range: input.range } });

      return await getOrganisationUsageReportDocuments({ ...input, userId: ctx.user.id });
    }),
});
