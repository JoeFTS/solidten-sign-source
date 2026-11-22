-- CreateTable
CREATE TABLE "RetiredSigningToken" (
    "tokenHash" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetiredSigningToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "RetiredSigningToken_envelopeId_idx" ON "RetiredSigningToken"("envelopeId");
