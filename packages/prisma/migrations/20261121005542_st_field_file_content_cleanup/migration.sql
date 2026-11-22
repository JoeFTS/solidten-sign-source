-- Solid Ten Sign (S-M5): when an attached file's row goes (with its envelope, recipient
-- or field, by cascade), its stored bytes go too. Database-stored content is removed
-- here, in the same transaction. Object-storage (S3_PATH) content is left for the daily
-- orphan sweep, which deletes the object first and then the row.
CREATE OR REPLACE FUNCTION "st_delete_field_file_content"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "DataContent" AS dc
  WHERE dc."id" = OLD."dataContentId"
    AND dc."type" <> 'S3_PATH'
    AND NOT EXISTS (SELECT 1 FROM "EnvelopeContent" AS ec WHERE ec."dataContentId" = dc."id");

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "st_field_file_upload_delete_content"
AFTER DELETE ON "FieldFileUpload"
FOR EACH ROW EXECUTE FUNCTION "st_delete_field_file_content"();
