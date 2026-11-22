-- AlterEnum
ALTER TYPE "FieldType" ADD VALUE 'FILE';

-- CreateTable
CREATE TABLE "FieldFileUpload" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "fieldId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "dataContentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaderName" TEXT NOT NULL,
    "uploaderEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldFileUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldFileUpload_dataContentId_key" ON "FieldFileUpload"("dataContentId");

-- CreateIndex
CREATE INDEX "FieldFileUpload_envelopeId_idx" ON "FieldFileUpload"("envelopeId");

-- CreateIndex
CREATE INDEX "FieldFileUpload_fieldId_idx" ON "FieldFileUpload"("fieldId");

-- CreateIndex
CREATE INDEX "FieldFileUpload_recipientId_idx" ON "FieldFileUpload"("recipientId");

-- AddForeignKey
ALTER TABLE "FieldFileUpload" ADD CONSTRAINT "FieldFileUpload_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldFileUpload" ADD CONSTRAINT "FieldFileUpload_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldFileUpload" ADD CONSTRAINT "FieldFileUpload_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldFileUpload" ADD CONSTRAINT "FieldFileUpload_dataContentId_fkey" FOREIGN KEY ("dataContentId") REFERENCES "DataContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
