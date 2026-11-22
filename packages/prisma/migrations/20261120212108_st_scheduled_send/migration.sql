-- CreateEnum
CREATE TYPE "EnvelopeScheduledSendStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "EnvelopeScheduledSend" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "EnvelopeScheduledSendStatus" NOT NULL DEFAULT 'SCHEDULED',
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvelopeScheduledSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnvelopeScheduledSend_envelopeId_key" ON "EnvelopeScheduledSend"("envelopeId");

-- CreateIndex
CREATE INDEX "EnvelopeScheduledSend_status_scheduledAt_idx" ON "EnvelopeScheduledSend"("status", "scheduledAt");

-- AddForeignKey
ALTER TABLE "EnvelopeScheduledSend" ADD CONSTRAINT "EnvelopeScheduledSend_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
