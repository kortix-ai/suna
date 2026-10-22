import { and, eq, sql } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../../shared/db';
import { FREE_TIER_PROJECT_LIMIT, maxProjectsForAccount } from '../../shared/account-limits';

/**
 * The per-account project cap (free → 1, paid → effectively uncapped). Returns
 * the typed 403 body to send, or null when the account may create another
 * project. Every isolated project counts, even when another project uses the
 * same Git repository or branch. The HTTP gate is `enforceProjectQuota`
 * (`http-project-access.ts`).
 */
export async function projectQuotaDenial(accountId: string) {
  const state = await projectQuotaState(accountId);
  if (!state.capped || state.message === null) return null;
  return {
    error: state.message,
    code: 'project_limit_reached',
    limit: state.limit,
    count: state.count,
  };
}

/**
 * The account's project-cap state, without the denial decision folded in.
 *
 * `GET /v1/projects/quota` serves this so the web /new page can show the cap
 * ON LOAD — the cap reason, before the user ever hits the 403 a denied create
 * answers. `projectQuotaDenial` derives its body from this same computation,
 * so the pre-check and the submit-time denial can never disagree about
 * whether the account is capped or what the message says.
 *
 * `count` is null exactly when the plan does not cap the account (billing
 * off, or Enterprise): no count query runs, so there is nothing to report.
 * `message` is non-null exactly when `capped` is true, and is byte-identical
 * to the denial body's `error`.
 */
export type ProjectQuotaState = {
  capped: boolean;
  limit: number;
  count: number | null;
  message: string | null;
};

export async function projectQuotaState(accountId: string): Promise<ProjectQuotaState> {
  const limit = await maxProjectsForAccount(accountId);
  if (limit >= Number.MAX_SAFE_INTEGER) {
    return { capped: false, limit, count: null, message: null };
  }

  // Count only ACTIVE projects — an archived (soft-deleted) project must not
  // permanently consume a free account's single slot.
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));
  const count = counted?.count ?? 0;
  if (count >= limit) {
    return { capped: true, limit, count, message: capMessage(limit) };
  }
  return { capped: false, limit, count, message: null };
}

function capMessage(limit: number): string {
  // FREE_TIER_PROJECT_LIMIT is 1, so this string is pluralized rather than
  // hardcoded — "limited to 1 projects" reads as a bug to the user.
  const projectsWord = limit === 1 ? 'project' : 'projects';
  return limit === FREE_TIER_PROJECT_LIMIT
    ? `Free accounts are limited to ${limit} ${projectsWord}. Upgrade to a paid plan to create more.`
    : `This account has reached its limit of ${limit} ${projectsWord}.`;
}

