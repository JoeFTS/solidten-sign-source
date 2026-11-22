-- AlterEnum
ALTER TYPE "WebhookTriggerEvents" ADD VALUE 'RECIPIENT_REASSIGNED';

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "allowSenderReassign" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowSignerReassign" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "allowSenderReassign" BOOLEAN,
ADD COLUMN     "allowSignerReassign" BOOLEAN;
