-- Profile pictures: a public "avatars" Storage bucket + per-user RLS.
--
-- The web app (User settings → profile) uploads to `${auth.uid()}/<file>` and
-- reads the public URL. Requires Supabase Storage to be enabled
-- (supabase/config.toml → [storage] enabled = true). After enabling, restart
-- the local stack (`supabase stop && supabase start`) so the storage schema is
-- initialised, then apply migrations.
--
-- Guarded: if the storage schema isn't present yet (storage disabled), this
-- migration no-ops instead of failing `db reset`.

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'storage' and table_name = 'buckets'
  ) then
    raise notice 'Storage schema not present — skipping avatars bucket setup. Enable [storage] in supabase/config.toml, restart Supabase, and re-run.';
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

  -- Anyone can read avatars (the bucket is public).
  execute $p$drop policy if exists "Avatar images are publicly readable" on storage.objects$p$;
  execute $p$create policy "Avatar images are publicly readable"
    on storage.objects for select
    using (bucket_id = 'avatars')$p$;

  -- A user may write only inside their own user-id folder.
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
