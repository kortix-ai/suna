import type { SupabaseClient } from '@supabase/supabase-js';

/** Remove stored pictures before reporting that the avatar is gone. */
export async function removeProfileAvatar(
  client: {
    storage: SupabaseClient['storage'];
    auth: {
      updateUser: (input: { data: { avatar_url: string } }) => Promise<{ error: Error | null }>;
    };
  },
  userId: string,
) {
  const bucket = client.storage.from('avatars');
  let previous = '';
  for (;;) {
    const { data, error } = await bucket.list(userId, { limit: 100 });
    if (error) throw error;
    if (!data?.length) break;
    const names = data.map((file) => file.name).join('\n');
    if (names === previous) throw new Error('Avatar storage cleanup did not complete');
    previous = names;
    const removed = await bucket.remove(data.map((file) => `${userId}/${file.name}`));
    if (removed.error) throw removed.error;
  }
  const { error } = await client.auth.updateUser({ data: { avatar_url: '' } });
  if (error) throw error;
}
