-- Migration: session_attachments_bucket
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The private `session-attachments` bucket: every session file under
-- `<project_id>/<session_id>/<attachment_id>`. User uploads, files an agent
-- showed (session-transcript-attachments.ts) and, since P2.3, session-log texts
-- over 256 kB (apps/api/src/projects/session-log-blobs.ts). The API reads and
-- writes it with supabase-js and the service role key.
--
-- Until now the API created the bucket at runtime, on the first upload
-- (`ensureBucket` in apps/api/src/projects/lib/session-attachments.ts). The
-- bucket is declared HERE instead, like 20260925105649894_config_releases_bucket.sql,
-- and the API no longer creates buckets. Every environment that ran an upload
-- already has the bucket: the upsert below keeps its id and objects and only
-- pins the two settings the runtime code enforced.
--
-- 52428800 bytes (50 MiB) is MAX_SESSION_ATTACHMENT_BYTES in
-- packages/shared/src/session-attachments.ts. No allowed_mime_types: a session
-- file has any type. No storage RLS policy: only the service role reaches the
-- bucket, so a browser cannot read an object directly.
--
-- Guarded like 20260826212608172_storage_branding_bucket.sql: a database
-- without Supabase's `storage` schema (a plain Postgres) skips this migration.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public'
  ) then
    raise notice 'storage.buckets not present or unexpected shape — skipping session attachments bucket setup.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values ('session-attachments', 'session-attachments', false, 52428800)
  on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit;
end $$;
