-- Solid Ten Sign (P-2): while a template's direct link is on, its direct signer must stay a
-- signer. Changing that recipient's role to VIEWER, APPROVER, ASSISTANT or CC, or deleting it,
-- left a link that does not work (visitors got "Mark as viewed" or a 404). One check for every
-- path (API v1/v2, web, legacy editor), deferred like the signature check: turning the link off
-- or deleting the link or the template in the same transaction is allowed. A change back to
-- SIGNER is always allowed, so a template already in that state can be repaired. Same advisory
-- lock as the signature check (see 20261124090000).
CREATE OR REPLACE FUNCTION "st_direct_link_signer_stays"() RETURNS trigger AS $$
DECLARE
  current_role text;
BEGIN
  IF OLD."role"::text <> 'SIGNER' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."role"::text = 'SIGNER' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "TemplateDirectLink" l
    WHERE l."directTemplateRecipientId" = OLD."id" AND l."envelopeId" = OLD."envelopeId" AND l."enabled"
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(1937, 1);

  IF NOT EXISTS (
    SELECT 1 FROM "TemplateDirectLink" l
    JOIN "Envelope" e ON e."id" = l."envelopeId"
    WHERE l."directTemplateRecipientId" = OLD."id" AND l."envelopeId" = OLD."envelopeId" AND l."enabled"
      AND e."type" = 'TEMPLATE'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT r."role"::text INTO current_role FROM "Recipient" r WHERE r."id" = OLD."id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ST_DIRECT_LINK_SIGNER:removed' USING ERRCODE = 'P0001';
  END IF;

  IF current_role <> 'SIGNER' THEN
    RAISE EXCEPTION 'ST_DIRECT_LINK_SIGNER:role' USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "st_recipient_direct_link_signer_stays"
AFTER DELETE OR UPDATE OF "role" ON "Recipient"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "st_direct_link_signer_stays"();
