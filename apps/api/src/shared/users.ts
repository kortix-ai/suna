import { getSupabase } from './supabase';

/**
 * Resolve a Kortix user id from an email via the Supabase admin API.
 * Canonical helper shared by account- and project-member invites. Paginates
 * the auth table (capped) and matches case-insensitively.
 */
export async function lookupUserIdByEmail(email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const supabase = getSupabase();
  const perPage = 200;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;
    for (const u of data.users) {
      if (u.email && u.email.trim().toLowerCase() === target) return u.id;
    }
    if (data.users.length < perPage) return null;
  }
  return null;
}
