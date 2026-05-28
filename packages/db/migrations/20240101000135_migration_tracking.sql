CREATE SCHEMA IF NOT EXISTS kortix_migrations;

CREATE TABLE IF NOT EXISTS kortix_migrations.applied (
  version       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by    TEXT NOT NULL DEFAULT current_user,
  execution_ms  INTEGER NOT NULL DEFAULT 0,
  dirty         BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS applied_checksum_idx ON kortix_migrations.applied (checksum);
CREATE INDEX IF NOT EXISTS applied_applied_at_idx ON kortix_migrations.applied (applied_at);
