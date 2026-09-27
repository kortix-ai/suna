/**
 * Member and session-owner identities are read from `auth.users` in one query
 * (`resolveUserIdentities`, projects/lib/access.ts). A test that mocks
 * `db.execute` must answer that query the way its auth-admin mock answers
 * `getUserById`, or every identity resolves as "no such user".
 *
 * Returns the rows for an `auth.users` identity read, or `null` for any other
 * statement so the caller falls through to its own `execute` behavior.
 */
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

export type AuthUserLookup = (id: string) => { email?: string | null; name?: string | null } | null;

export function authUsersRows(query: unknown, lookup: AuthUserLookup): Record<string, unknown>[] | null {
  let compiled: { sql: string; params: unknown[] };
  try {
    compiled = dialect.sqlToQuery(query as never);
  } catch {
    return null;
  }
  if (!/from auth\.users/i.test(compiled.sql)) return null;
  const ids = String(compiled.params[0] ?? '')
    .replace(/[{}]/g, '')
    .split(',')
    .filter(Boolean);
  return ids.flatMap((id) => {
    const user = lookup(id);
    return user ? [{ id, email: user.email ?? null, name: user.name ?? null, full_name: null }] : [];
  });
}
