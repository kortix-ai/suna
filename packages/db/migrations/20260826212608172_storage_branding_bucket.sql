-- Migration: storage_branding_bucket
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Organization branding assets (logo / icon / favicon): a public "branding"
-- Storage bucket. Objects are written ONLY by the API through the service-role
-- client (`POST /v1/accounts/:id/branding/assets/:kind`, gated on
-- `account.write` + the `branding` entitlement), so there is no client-side
-- INSERT/UPDATE/DELETE policy — only public read, which is what an <img src>
-- and a <link rel="icon"> need.
--
-- Mirrors 20260621094136411_storage_avatars.sql: targets the Supabase-managed
-- `storage.*` platform schema, so it is guarded and no-ops when storage is
-- absent or shaped differently, instead of failing the migration run.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public'
  ) then
    raise notice 'storage.buckets not present or unexpected shape — skipping branding bucket setup.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'branding', 'branding', true, 1048576,
    array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']
  )
  on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists "Branding assets are publicly readable" on storage.objects$p$;
  execute $p$create policy "Branding assets are publicly readable"
    on storage.objects for select
    using (bucket_id = 'branding')$p$;
end $$;
