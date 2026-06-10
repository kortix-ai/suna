-- Provider analytics — append-only telemetry log.
--
-- One row per terminal provisioning/migration outcome, written fire-and-forget
-- from the provision path (the provision timeline is already computed, so it's
-- ~free). Survives the session_sandboxes row being deleted (e.g. on migration),
-- which is why it's a separate append-only table rather than derived from live
-- rows. Powers the admin Providers → Analytics tab. See packages/db schema
-- `providerEvents` and apps/api/src/platform/services/provider-events.ts.
-- Self-created here too (CREATE TABLE IF NOT EXISTS) because drizzle-kit push is
-- fragile on this mixed-migration DB; idempotent so ensureSchema can re-run it.
CREATE TABLE IF NOT EXISTS kortix.provider_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text        NOT NULL,
  kind         text        NOT NULL,            -- 'provision' | 'migrate'
  outcome      text        NOT NULL,            -- 'ok' | 'error' | 'stopped'
  total_ms     integer,
  marks        jsonb       DEFAULT '[]'::jsonb, -- [{ label, atMs, deltaMs }]
  attempts     integer     DEFAULT 1,
  error_class  text,                            -- 'capacity' | 'other' | null
  error        text,
  from_provider text,                           -- migrate: source provider
  session_id   text,
  account_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_events_provider ON kortix.provider_events (provider);
CREATE INDEX IF NOT EXISTS idx_provider_events_kind     ON kortix.provider_events (kind);
CREATE INDEX IF NOT EXISTS idx_provider_events_outcome  ON kortix.provider_events (outcome);
CREATE INDEX IF NOT EXISTS idx_provider_events_created  ON kortix.provider_events (created_at);

-- Grants (this migration runs after 00000000000001_table_grants on a fresh DB).
GRANT ALL ON kortix.provider_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON kortix.provider_events TO authenticated;
GRANT SELECT ON kortix.provider_events TO anon;
