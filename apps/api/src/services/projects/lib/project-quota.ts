import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { projects } from '@kortix/db';
import { db } from '../../../lib/db';
import { FREE_TIER_PROJECT_LIMIT, maxProjectsForAccount } from '../../billing/account-limits';

// Enforce the per-account project cap (free → 1, paid → effectively uncapped).
// Returns a typed 403 response to send, or null when the account may create another
// project. Every isolated project counts, even when another project uses the
// same Git repository or branch.
export async function enforceProjectQuota(
  c: Context,
  accountId: string,
) {
  const limit = await maxProjectsForAccount(accountId);
  if (limit >= Number.MAX_SAFE_INTEGER) return null;

  // Count only ACTIVE projects — an archived (soft-deleted) project must not
  // permanently consume a free account's single slot.
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));
  const count = counted?.count ?? 0;
  if (count >= limit) {
    // FREE_TIER_PROJECT_LIMIT is 1, so this string is pluralized rather than
    // hardcoded — "limited to 1 projects" reads as a bug to the user.
    const projectsWord = limit === 1 ? 'project' : 'projects';
    return c.json(
      {
        error:
          limit === FREE_TIER_PROJECT_LIMIT
            ? `Free accounts are limited to ${limit} ${projectsWord}. Upgrade to a paid plan to create more.`
            : `This account has reached its limit of ${limit} ${projectsWord}.`,
        code: 'project_limit_reached',
        limit,
        count,
      },
      403,
    );
  }
  return null;
}

