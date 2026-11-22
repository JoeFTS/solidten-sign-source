-- CreateEnum
CREATE TYPE "InPersonSigningPhase" AS ENUM ('HOST', 'HANDOVER', 'SIGNER', 'HANDBACK');

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "allowInPersonSigning" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "stInPersonSessionId" TEXT;

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "allowInPersonSigning" BOOLEAN;

-- CreateTable
CREATE TABLE "InPersonSigningSession" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "hostUserId" INTEGER NOT NULL,
    "authSessionId" TEXT NOT NULL,
    "exitPinHash" TEXT NOT NULL,
    "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailCodeRecipientIds" INTEGER[],
    "phase" "InPersonSigningPhase" NOT NULL DEFAULT 'HOST',
    "recipientId" INTEGER,
    "recipientToken" TEXT,
    "confirmedName" TEXT,
    "emailCodeSentAt" TIMESTAMP(3),
    "emailCodeVerifiedAt" TIMESTAMP(3),
    "turnStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "InPersonSigningSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InPersonSigningSession_envelopeId_idx" ON "InPersonSigningSession"("envelopeId");

-- CreateIndex
CREATE INDEX "InPersonSigningSession_authSessionId_idx" ON "InPersonSigningSession"("authSessionId");

-- AddForeignKey
ALTER TABLE "InPersonSigningSession" ADD CONSTRAINT "InPersonSigningSession_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
