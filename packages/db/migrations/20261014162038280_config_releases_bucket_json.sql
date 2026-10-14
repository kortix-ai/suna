-- Migration: config_releases_bucket_json
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Let the `kortix-config-releases` bucket hold JSON as well as gzip. The API
-- now writes each published release's descriptor next to its archive
-- (`projects/<project>/releases/<commit>-<ms>.json`, apps/api/src/config-releases/publish.ts),
-- and Supabase Storage refused it: "mime type application/json is not
-- supported" (local stack, 2026-10-14). Old code writes gzip only, which the
-- wider list still accepts.
--
-- Guarded like 20261005142708957_config_releases_bucket_32mib.sql: a no-op
-- where the Supabase `storage` schema is absent (AWS environments use S3, no
-- type list there).

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types'
  ) then
    raise notice 'storage.buckets not present or unexpected shape — skipping config releases bucket types.';
    return;
  end if;

  update storage.buckets
     set allowed_mime_types = array['application/gzip', 'application/json']
   where id = 'kortix-config-releases';
end $$;
