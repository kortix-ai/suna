/**
 * Batched, cached user-email lookup.
 *
 * `resolveAccountDisplayNames` needs the OWNER's email to render a fallback name
 * for placeholder-named accounts. It used to get them from
 * `supabase.auth.admin.getUserById()` — one HTTPS call per owner, fanned out
 * with `Promise.all` and awaited inside `GET /v1/accounts`. That fan-out is free
 * against a localhost Supabase and costs one Auth-API round trip per owner
 * against a hosted project, so the route blocked on N remote calls.
 *
 * `auth.users` is in the same Postgres the API already pools, and reading it
 * directly is the established pattern in this codebase (`shared/users.ts`,
 * `shared/platform-roles.ts`, `admin/index.ts`). One indexed lookup replaces the
 * fan-out, and a short TTL cache collapses repeat calls.
 *
 * Kept as a leaf module (only `db` + `sql`) so it stays unit-testable.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';

// Owner emails change rarely and only decorate a display name, so a short TTL
// is the right trade. Bounded so a large tenant cannot grow the map without end.
export const OWNER_EMAIL_TTL_MS = 5 * 60 * 1000;
export const OWNER_EMAIL_CACHE_MAX = 5_000;

interface CacheEntry {
  email: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearOwnerEmailCache(): void {
  cache.clear();
}

export function ownerEmailCacheSize(): number {
  return cache.size;
}

/**
 * Resolve emails for a batch of user ids using ONE query for everything not
 * already cached. Unknown ids resolve to `null`. Never throws: a failed lookup
 * degrades the account name, it does not fail the request.
 */
export async function lookupEmailsByUserIds(
  userIds: string[],
  now: number = Date.now(),
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (userIds.length === 0) return result;

  const misses: string[] = [];
  for (const uid of new Set(userIds)) {
    const hit = cache.get(uid);
    if (hit && hit.expiresAt > now) result.set(uid, hit.email);
    else misses.push(uid);
  }
  if (misses.length === 0) return result;

  try {
    // Explicit placeholder list. Drizzle renders a bare JS array as
    // `($1, $2, …)`, so both `ANY(${ids}::uuid[])` and `IN (${ids})` produce
    // invalid SQL — verified against the live postgres-js driver.
    const placeholders = sql.join(
      misses.map((uid) => sql`${uid}::uuid`),
      sql`, `,
    );
    const rows = (await db.execute(
      sql`SELECT id::text AS id, email FROM auth.users WHERE id IN (${placeholders})`,
    )) as unknown as Array<{ id: string; email: string | null }>;
    for (const r of rows) result.set(r.id, r.email ?? null);
  } catch {
    // auth.users unreachable (restricted role, schema absent). Fall through and
    // cache nothing, so the next call retries rather than pinning a wrong null.
    for (const uid of misses) if (!result.has(uid)) result.set(uid, null);
    return result;
  }

  for (const uid of misses) {
    // Cache misses as null too: a deleted user id would otherwise re-query on
    // every account list.
    if (!result.has(uid)) result.set(uid, null);
    if (cache.size >= OWNER_EMAIL_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(uid, { email: result.get(uid) ?? null, expiresAt: now + OWNER_EMAIL_TTL_MS });
  }
  return result;
}
