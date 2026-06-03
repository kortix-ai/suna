import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * Resolve a Kortix user id from an email via a direct, indexed lookup against
 * auth.users. Canonical helper shared by account- and project-member invites.
 * Supabase normalizes emails to lowercase at signup, so an equality match on
 * the already-lowercased target hits the email index (same approach as the
 * access-control auth.users check).
 */
export async function lookupUserIdByEmail(email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const rows = await db.execute(
    sql`SELECT id FROM auth.users WHERE email = ${target} LIMIT 1`,
  );
  const row = rows[0] as { id?: string } | undefined;
  return row?.id ?? null;
}
