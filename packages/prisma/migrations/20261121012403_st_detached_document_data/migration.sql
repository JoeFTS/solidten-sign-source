-- CreateTable
CREATE TABLE "DetachedDocumentData" (
    "documentDataId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetachedDocumentData_pkey" PRIMARY KEY ("documentDataId")
);

-- CreateIndex
CREATE INDEX "DetachedDocumentData_envelopeId_idx" ON "DetachedDocumentData"("envelopeId");

-- Solid Ten Sign: record the stored-data row an envelope item stops pointing at,
-- whichever code path changes it, so a retention purge can delete it by id.
CREATE OR REPLACE FUNCTION "st_record_detached_document_data"() RETURNS trigger AS $$
BEGIN
  IF NEW."documentDataId" IS DISTINCT FROM OLD."documentDataId" THEN
    INSERT INTO "DetachedDocumentData" ("documentDataId", "envelopeId")
    VALUES (OLD."documentDataId", OLD."envelopeId")
    ON CONFLICT ("documentDataId") DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "st_envelope_item_document_data_detached"
AFTER UPDATE OF "documentDataId" ON "EnvelopeItem"
FOR EACH ROW
EXECUTE FUNCTION "st_record_detached_document_data"();
