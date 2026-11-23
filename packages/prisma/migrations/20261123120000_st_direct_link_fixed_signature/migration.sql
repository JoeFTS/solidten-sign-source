-- Solid Ten Sign (O-F1): a template whose direct link is on must keep, for every signer, a
-- signature field that no condition can hide. One check for every path that changes or removes
-- a field (editor set/update/delete, API v1 and v2, bulk paths, PDF replace, page removal...).
--
-- Only a change that takes a signer's LAST unconditional signature field away is refused: the
-- OLD row was such a field, and after the transaction the signer has none. A template that was
-- already faulty is not blocked from being edited (and fixed).
--
-- Deferred to the end of the transaction, so a save that removes and re-creates fields in one
-- transaction, or that removes the signer itself, is judged on its result.
CREATE OR REPLACE FUNCTION "st_field_is_fixed_signature"("fieldType" "FieldType", "meta" jsonb) RETURNS boolean AS $$
  SELECT "fieldType"::text IN ('SIGNATURE', 'FREE_SIGNATURE')
     AND COALESCE(jsonb_typeof("meta" -> 'condition'), 'null') <> 'object';
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "st_direct_link_keeps_fixed_signature"() RETURNS trigger AS $$
DECLARE
  link_recipient_id integer;
  signer RECORD;
BEGIN
  IF NOT "st_field_is_fixed_signature"(OLD."type", OLD."fieldMeta"::jsonb) THEN
    RETURN NULL;
  END IF;

  SELECT l."directTemplateRecipientId" INTO link_recipient_id
  FROM "TemplateDirectLink" l
  JOIN "Envelope" e ON e."id" = l."envelopeId"
  WHERE l."envelopeId" = OLD."envelopeId" AND l."enabled" AND e."type" = 'TEMPLATE';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT r."id", r."name", r."email" INTO signer
  FROM "Recipient" r
  WHERE r."id" = OLD."recipientId" AND r."envelopeId" = OLD."envelopeId" AND r."role" = 'SIGNER';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Field" f
    WHERE f."recipientId" = signer."id" AND "st_field_is_fixed_signature"(f."type", f."fieldMeta"::jsonb)
  ) THEN
    RETURN NULL;
  END IF;

  -- The app turns this into a plain message (AppError.parseError). The direct link signer has a
  -- placeholder address, so it is named by its role.
  RAISE EXCEPTION 'ST_DIRECT_LINK_FIXED_SIGNATURE:%',
    CASE WHEN signer."id" = link_recipient_id THEN 'direct' ELSE COALESCE(NULLIF(signer."name", ''), signer."email") END
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "st_field_direct_link_fixed_signature"
AFTER DELETE OR UPDATE OF "type", "recipientId", "fieldMeta", "envelopeId" ON "Field"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "st_direct_link_keeps_fixed_signature"();
