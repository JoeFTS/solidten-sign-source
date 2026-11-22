import { adminRouter } from './admin-router/router';
import { apiTokenRouter } from './api-token-router/router';
import { authRouter } from './auth-router/router';
import { commentRouter } from './comment-router/router';
import { documentRouter } from './document-router/router';
import { embeddingPresignRouter } from './embedding-router/_router';
import { enterpriseRouter } from './enterprise-router/router';
import { envelopeRouter } from './envelope-router/router';
import { fieldFileRouter } from './field-file-router/router';
import { fieldRouter } from './field-router/router';
import { folderRouter } from './folder-router/router';
import { inPersonRouter } from './in-person-router/router';
import { lifecycleRouter } from './lifecycle-router/router';
import { organisationRouter } from './organisation-router/router';
import { profileRouter } from './profile-router/router';
import { publicFormRouter } from './public-form-router/router';
import { recipientRouter } from './recipient-router/router';
import { smsRouter } from './sms-router/router';
import { teamRouter } from './team-router/router';
import { templateRouter } from './template-router/router';
import { router } from './trpc';
import { usageReportRouter } from './usage-report-router/router';
import { webhookRouter } from './webhook-router/router';

export const appRouter = router({
  enterprise: enterpriseRouter,
  envelope: envelopeRouter,
  auth: authRouter,
  profile: profileRouter,
  document: documentRouter,
  field: fieldRouter,
  folder: folderRouter,
  recipient: recipientRouter,
  admin: adminRouter,
  organisation: organisationRouter,
  apiToken: apiTokenRouter,
  team: teamRouter,
  template: templateRouter,
  webhook: webhookRouter,
  embeddingPresign: embeddingPresignRouter,
  sms: smsRouter,
  usageReport: usageReportRouter,
  lifecycle: lifecycleRouter,
  publicForm: publicFormRouter,
  fieldFile: fieldFileRouter,
  inPerson: inPersonRouter,
  comment: commentRouter,
});

export type AppRouter = typeof appRouter;
