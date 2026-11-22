-- AlterTable
ALTER TABLE "InPersonSigningSession" ADD COLUMN     "turnToken" TEXT,
ADD COLUMN     "turnTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "InPersonSigningSession_turnToken_key" ON "InPersonSigningSession"("turnToken");
