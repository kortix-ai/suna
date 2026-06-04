/**
 * Resolves which account-members table exists in the current database.
 *
 * Cloud prod and some legacy deployments still use `basejump.account_user`
 * (columns: user_id, account_id, account_role). Newer Kortix-native
 * deployments use `kortix.account_members` (same shape + created_at).
 *
 * Admin panel SQL embeds the table name inline in subqueries, so we need the
 * name as a raw SQL chunk. We probe once on first call and cache the result.
 */

import { sql, type SQL } from 'drizzle-orm';

type MembersTable = 'kortix.account_members' | 'basejump.account_user';

let cached: MembersTable | null = null;
let probing: Promise<MembersTable> | null = null;

async function probe(): Promise<MembersTable> {
  const { db } = await import('../shared/db');
  try {
    await db.execute(sql`SELECT 1 FROM kortix.account_members LIMIT 1`);
    return 'kortix.account_members';
  } catch {
    return 'basejump.account_user';
  }
}

export async function resolveMembersTable(): Promise<MembersTable> {
  if (cached) return cached;
  if (!probing) {
    probing = probe().then((t) => {
      cached = t;
      probing = null;
      return t;
    });
  }
  return probing;
}

/** Raw SQL chunk for embedding in `sql\`… ${mt} …\`` templates. */
export async function membersTableSql(): Promise<SQL> {
  const t = await resolveMembersTable();
  return sql.raw(t);
}
