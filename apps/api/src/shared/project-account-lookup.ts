/**
 * The account a project belongs to, for the audit log.
 *
 * An audit row is shown to the account in its `account_id`. A row that names
 * a project but no account — a verified per-project webhook, an invalid token
 * aimed at a project URL — would otherwise land in nobody's log. The request
 * audit resolves the owner here when the row is written. A project's account
 * never changes, so the answer is cached; only a found project is cached.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from './db';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { accountId: string; expiresAt: number }>();

export async function resolveProjectAccountId(projectId: string): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(projectId);
  if (hit && hit.expiresAt > now) return hit.accountId;
  const [row] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row?.accountId) return null;
  cache.set(projectId, { accountId: row.accountId, expiresAt: now + TTL_MS });
  if (cache.size > 10_000) {
    for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
  }
  return row.accountId;
}

export function __clearProjectAccountLookupForTests(): void {
  cache.clear();
}
