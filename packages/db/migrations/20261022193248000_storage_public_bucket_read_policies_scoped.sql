-- Migration: storage_public_bucket_read_policies_scoped
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The avatars and branding buckets are `public`, which already lets anyone GET
-- an object by path through /storage/v1/object/public/<bucket>/<path> without
-- touching RLS. Their SELECT policies, however, were written with no `to`
-- clause, so they also applied to `anon` — and that is what makes the bucket
-- LISTABLE: an anonymous `POST /storage/v1/object/list/<bucket>` enumerated
-- every object name in it (pentest 2026-10-22).
--
-- Listing is only ever done by a signed-in client (`bucket.list(userId)` before
-- removing an old avatar, apps/web/src/features/workspace/settings/tabs/
-- profile-avatar.ts), so scoping the read policy to `authenticated` keeps every
-- caller working and closes anonymous enumeration. Public object URLs, which is
-- how every <img>/<link rel=icon> reads these buckets, never consult this
-- policy at all.
--
-- Guarded like the migrations that created the buckets: targets the
-- Supabase-managed `storage.*` schema, so it no-ops when storage is absent or
-- shaped differently instead of aborting a migration run.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public'
  ) then
    raise notice 'storage.buckets not present or unexpected shape — skipping public bucket read policies.';
    return;
  end if;

  execute $p$drop policy if exists "Avatar images are publicly readable" on storage.objects$p$;
  execute $p$drop policy if exists "Avatar images are readable by signed-in users" on storage.objects$p$;
  execute $p$create policy "Avatar images are readable by signed-in users"
    on storage.objects for select to authenticated
    using (bucket_id = 'avatars')$p$;

  execute $p$drop policy if exists "Branding assets are publicly readable" on storage.objects$p$;
  execute $p$drop policy if exists "Branding assets are readable by signed-in users" on storage.objects$p$;
  execute $p$create policy "Branding assets are readable by signed-in users"
    on storage.objects for select to authenticated
    using (bucket_id = 'branding')$p$;
end $$;
