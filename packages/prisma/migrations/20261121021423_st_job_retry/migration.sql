-- AlterTable
ALTER TABLE "BackgroundJob" ADD COLUMN     "nextRunAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Recipient" ADD COLUMN     "deliveryFailedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "BackgroundJob_status_nextRunAt_idx" ON "BackgroundJob"("status", "nextRunAt");
