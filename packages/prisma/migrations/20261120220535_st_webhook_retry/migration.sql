-- AlterTable
ALTER TABLE "WebhookCall" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "WebhookCall_nextAttemptAt_idx" ON "WebhookCall"("nextAttemptAt");
