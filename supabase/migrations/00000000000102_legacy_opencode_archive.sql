-- Store the legacy machine's OpenCode store (opencode.db tarball, base64) on the
-- migration row so chat rehydrate at session-open time reads it from our own DB
-- rather than re-pulling from the live legacy VM. Makes "open a migrated session
-- -> chat restored" fully self-contained: no JustAVPS key, no live VM, no
-- external object storage needed at open time.
--
-- opencode.db is typically ~1-5MB; Postgres TOAST handles this column fine. For
-- very large legacy stores, swap to object storage.
ALTER TABLE "kortix"."legacy_sandbox_migrations"
  ADD COLUMN IF NOT EXISTS "opencode_archive" text;
