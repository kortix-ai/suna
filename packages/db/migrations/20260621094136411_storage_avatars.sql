-- 20260621094136411_storage_avatars.sql
-- Profile pictures: a public "avatars" Storage bucket + per-user RLS.
--
-- Split out from the baseline because it targets Supabase-managed `storage.*`
-- (a platform schema), not our `kortix` schema. Guarded: if the storage schema
-- isn't present (storage disabled, or a fresh DB before the storage service has
-- initialised), it no-ops instead of failing the run.

do $$
begin
  -- Skip gracefully unless storage.buckets exists AND has the column shape this
  -- migration writes. The avatars bucket is a platform convenience, not part of
  -- our schema — it must never abort a migration run because the Supabase
  -- storage-api version differs (or storage is disabled).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'public'
  ) then
    raise notice 'storage.buckets not present or unexpected shape — skipping avatars bucket setup.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'avatars', 'avatars', true, 5242880,
    array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  )
  on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists "Avatar images are publicly readable" on storage.objects$p$;
  execute $p$create policy "Avatar images are publicly readable"
    on storage.objects for select
    using (bucket_id = 'avatars')$p$;

  execute $p$drop policy if exists "Users manage own avatar (insert)" on storage.objects$p$;
  execute $p$create policy "Users manage own avatar (insert)"
    on storage.objects for insert to authenticated
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)$p$;

  execute $p$drop policy if exists "Users manage own avatar (update)" on storage.objects$p$;
  execute $p$create policy "Users manage own avatar (update)"
    on storage.objects for update to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)$p$;

  execute $p$drop policy if exists "Users manage own avatar (delete)" on storage.objects$p$;
  execute $p$create policy "Users manage own avatar (delete)"
    on storage.objects for delete to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
end $$;
