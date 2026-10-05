/**
 * Who a Capture user id is, for Ask: the display name and email of members of
 * one account, as the account's member directory shows them (every member of
 * an account sees the directory's emails). An id that is not a member of the
 * account resolves to nothing.
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';

export interface Person {
  name: string;
  email: string | null;
}

export async function accountPeople(accountId: string, userIds: string[]): Promise<Map<string, Person>> {
  const ids = [...new Set(userIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const out = new Map<string, Person>();
  if (!ids.length) return out;
  try {
    const rows = (await db.execute(sql`
      SELECT u.id::text AS id, u.email,
             coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), nullif(trim(u.raw_user_meta_data->>'name'), '')) AS name
        FROM auth.users u
        JOIN kortix.account_members m ON m.user_id = u.id AND m.account_id = ${accountId}::uuid
       WHERE u.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as Array<{ id: string; email: string | null; name: string | null }>;
    for (const r of rows) out.set(r.id, { name: r.name ?? r.email?.split('@')[0] ?? 'A member', email: r.email });
  } catch {
    // auth.users unreadable (restricted role): Ask answers with user ids only.
  }
  return out;
}
