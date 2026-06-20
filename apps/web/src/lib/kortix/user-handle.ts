import type { User } from '@supabase/supabase-js';

/**
 * Derive a stable @handle for the current real human from their auth profile.
 *
 * Used as the assignee id for `assignee_type === 'user'` tickets, shown in the
 * team roster, and stored on projects (`user_handle` column) so CONTEXT.md
 * refers to the human by handle. Future multi-user support will replace this
 * with a per-user table — the handle remains the display key.
 */
export function getUserHandle(user: User | null | undefined): string {
  if (!user) return 'me';
  const raw =
    (user.user_metadata?.username as string | undefined) ||
    (user.user_metadata?.preferred_username as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    user.email?.split('@')[0] ||
    'me';
  return raw.toString().trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'me';
}
