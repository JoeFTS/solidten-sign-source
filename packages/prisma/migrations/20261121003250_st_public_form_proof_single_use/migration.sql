-- AlterTable
ALTER TABLE "StPublicFormSubmission" ADD COLUMN     "verifiedProofHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "StPublicFormSubmission_verifiedProofHash_key" ON "StPublicFormSubmission"("verifiedProofHash");
