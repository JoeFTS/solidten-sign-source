-- Solid Ten Sign (P-1): close the race in the direct link signature check (20261123120000).
--
-- At READ COMMITTED, two transactions that each delete one of a signer's two unconditional
-- signature fields both passed their deferred check: each check ran before the other committed
-- and still saw the other's field (write skew). The check now takes a transaction-level advisory
-- lock before it counts. The second transaction waits until the first commits; its count, a new
-- statement with a new snapshot, then sees the first one's delete and refuses.
--
-- Why an advisory lock, not a row lock on "Envelope": the app locks the Envelope row (FOR UPDATE)
-- early in many transactions (recipient changes, contents, file fields, transitions) and then
-- writes Field rows. A check that locked the Envelope row at commit, while holding Field row
-- locks, could deadlock with such a transaction. No app code takes this advisory lock, and the
-- check holds it only for plain reads, so it never waits on anything while holding it: no cycle
-- is possible. One key for all templates, so a transaction that touches several templates cannot
-- take two keys in opposite orders. It is taken only by a change that removes an unconditional
-- signature field from a template whose link is on (rare), after the cheap checks.
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
    WHERE l."envelopeId" = OLD."envelopeId" AND l."enabled" AND e."type" = 'TEMPLATE'
  ) THEN
    RETURN NULL;
  END IF;

  -- Serialise the checks; released at the end of the transaction. 1937 = 'st' namespace.
  PERFORM pg_advisory_xact_lock(1937, 1);

  -- Read again after the wait: the other transaction may have turned the link off or removed
  -- the signer or the template.
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
