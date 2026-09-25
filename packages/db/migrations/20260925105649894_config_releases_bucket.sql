-- Migration: config_releases_bucket
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The private `kortix-config-releases` bucket that holds config archives in
-- every Supabase-backed environment (local dev, preview, self-host). The API
-- reaches it through Supabase Storage's S3 PROTOCOL endpoint with the one
-- object store (apps/api/src/object-store/s3.ts); on AWS the same code points
-- at a Terraform-owned S3 bucket instead.
--
-- The bucket is created HERE, declaratively, because the API no longer creates
-- buckets at runtime: a store that can mint its own bucket cannot tell a
-- missing bucket from a rejected credential (docs/specs/config-releases.md,
-- "Store").
--
-- No storage RLS policy: every object is written and read by the API through
-- the S3 protocol key pair, which bypasses `storage.objects` policies. A
-- browser must never read an archive directly, so the bucket stays private and
-- policy-free, exactly like `staged-files`.
--
-- Mirrors 20260826212608172_storage_branding_bucket.sql: targets the
-- Supabase-managed `storage.*` platform schema, so it is guarded and no-ops
-- when storage is absent or shaped differently, instead of failing the
-- migration run.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public'
  ) then
    raise notice 'storage.buckets not present or unexpected shape — skipping config releases bucket setup.';
    return;
  end if;

  -- 4 MiB is MAX_CONFIG_ARCHIVE_BYTES in apps/api/src/config-releases/builder.ts.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('kortix-config-releases', 'kortix-config-releases', false, 4194304, array['application/gzip'])
  on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
end $$;
