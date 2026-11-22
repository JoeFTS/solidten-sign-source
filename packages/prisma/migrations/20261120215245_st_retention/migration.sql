-- AlterEnum
ALTER TYPE "WebhookTriggerEvents" ADD VALUE 'DOCUMENT_PURGED';

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "retentionSettings" JSONB;

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "retentionSettings" JSONB;
