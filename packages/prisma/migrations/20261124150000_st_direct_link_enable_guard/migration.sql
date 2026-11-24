-- Solid Ten Sign (Q-1): turning a direct link on (or pointing an enabled link at another signer,
-- or creating an enabled link) must leave a link a visitor can use. The Field and Recipient checks
-- (20261123120000, 20261124090100) guard changes while the link is on; this guards the moment it
-- goes on. Same advisory lock, so "role change vs link on" and "field removal vs link on" races
-- are serialised: the later commit waits, then sees the earlier one.
--
-- Fires only when a write makes a link enabled with (possibly) a new signer: INSERT of an enabled
-- link, UPDATE that turns "enabled" on, or UPDATE of the signer or template of an enabled link.
-- A link that is already on is not re-checked by unrelated updates (the token is not watched,
-- and enabled on -> on is skipped), so an already broken template stays editable and repairable.
-- Deleting the link, the template, the team or the user never runs it (no DELETE trigger; at
-- commit a link that is gone or off is skipped).
--
-- At commit, while the link is still on:
-- - the signer is missing, or is not a SIGNER: refused (also for a new link);
-- - the signer has no signature field without a condition: refused when the link is turned on
--   or moved to another signer. A new link may start without fields (upstream creates a
--   placeholder signer first and the sender adds fields after), as before.
CREATE OR REPLACE FUNCTION "st_direct_link_enable_guard"() RETURNS trigger AS $$
DECLARE
  link RECORD;
  signer_role text;
BEGIN
  IF NOT NEW."enabled" THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."enabled"
     AND OLD."directTemplateRecipientId" = NEW."directTemplateRecipientId"
     AND OLD."envelopeId" = NEW."envelopeId" THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(1937, 1);

  -- The link as it is now, at commit: it may have been turned off or deleted since.
  SELECT l."id", l."enabled", l."envelopeId", l."directTemplateRecipientId" INTO link
  FROM "TemplateDirectLink" l
  JOIN "Envelope" e ON e."id" = l."envelopeId"
  WHERE l."id" = NEW."id" AND e."type" = 'TEMPLATE';

  IF NOT FOUND OR NOT link."enabled" THEN
    RETURN NULL;
  END IF;

  SELECT r."role"::text INTO signer_role
  FROM "Recipient" r
  WHERE r."id" = link."directTemplateRecipientId" AND r."envelopeId" = link."envelopeId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ST_DIRECT_LINK_ENABLE:missing' USING ERRCODE = 'P0001';
  END IF;

  IF signer_role <> 'SIGNER' THEN
    RAISE EXCEPTION 'ST_DIRECT_LINK_ENABLE:role' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND NOT EXISTS (
    SELECT 1 FROM "Field" f
    WHERE f."recipientId" = link."directTemplateRecipientId"
      AND "st_field_is_fixed_signature"(f."type", f."fieldMeta"::jsonb)
  ) THEN
    RAISE EXCEPTION 'ST_DIRECT_LINK_ENABLE:signature' USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "st_template_direct_link_enable_guard"
AFTER INSERT OR UPDATE OF "enabled", "directTemplateRecipientId", "envelopeId" ON "TemplateDirectLink"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "st_direct_link_enable_guard"();

-- The Field and Recipient checks skipped the lock when the link was off at the moment they
-- looked. A link being turned on in a parallel, not yet committed transaction was then missed
-- (write skew: field removal vs link on, role change vs link on). They now take the lock when the
-- template HAS a link (on or off), and only then look at "enabled".
CREATE OR REPLACE FUNCTION "st_direct_link_keeps_fixed_signature"() RETURNS trigger AS $$
DECLARE
  link_recipient_id integer;
  signer RECORD;
BEGIN
  IF NOT "st_field_is_fixed_signature"(OLD."type", OLD."fieldMeta"::jsonb) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "TemplateDirectLink" l
    JOIN "Envelope" e ON e."id" = l."envelopeId"
    WHERE l."envelopeId" = OLD."envelopeId" AND e."type" = 'TEMPLATE'
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(1937, 1);

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

  RAISE EXCEPTION 'ST_DIRECT_LINK_FIXED_SIGNATURE:%',
    CASE WHEN signer."id" = link_recipient_id THEN 'direct' ELSE COALESCE(NULLIF(signer."name", ''), signer."email") END
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

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
    WHERE l."directTemplateRecipientId" = OLD."id" AND l."envelopeId" = OLD."envelopeId"
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
