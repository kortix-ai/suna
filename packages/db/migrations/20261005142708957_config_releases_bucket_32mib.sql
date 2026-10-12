-- Migration: config_releases_bucket_32mib
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Raise the `kortix-config-releases` bucket's object limit from 4 MiB to
-- 32 MiB, the API's new `MAX_CONFIG_ARCHIVE_BYTES`
-- (apps/api/src/config-releases/release-tree.ts). A release carries the root
-- `skills/`, and one skill with templates or images passed 4 MiB: the project
-- then got no release at all (2026-10-05). Old code writes archives of at most
-- 4 MiB, which the higher limit still accepts.
--
-- Guarded like 20260925105649894_config_releases_bucket.sql: a no-op where the
-- Supabase `storage` schema is absent (AWS environments use S3, no limit here).

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
  ) then
    raise notice 'storage.buckets not present or unexpected shape — skipping config releases bucket limit.';
    return;
  end if;

  update storage.buckets set file_size_limit = 33554432 where id = 'kortix-config-releases';
end $$;
