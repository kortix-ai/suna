/**
 * Where the app opens: the project the user had open last, else the first
 * project. Never the Projects list — the list is a place the user chooses from
 * the project menu (All projects), not a place the app drops them.
 *
 * Mirror of web's `/projects/start` resolver
 * (apps/web/src/lib/onboarding/resolve-landing-destination.ts) without
 * auto-provisioning: with no project in any account the caller opens the
 * Projects list, the one mobile surface that creates a project.
 *
 * Pure: the project lists come in through `listProjects`, so tests pass plain
 * fakes instead of module-mocking the SDK.
 */

import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';

export type LandingResolution =
  | { kind: 'project'; projectId: string; accountId: string }
  | { kind: 'empty' };

function canCreateIn(account: KortixAccount): boolean {
  return account.account_role === 'owner' || account.account_role === 'admin';
}

/**
 * Accounts in the order they are searched: the selected account, then the
 * accounts the user owns or administers, then member-only accounts.
 */
export function orderLandingAccounts(
  accounts: KortixAccount[],
  selectedAccountId: string | null
): KortixAccount[] {
  const selected = accounts.find((account) => account.account_id === selectedAccountId);
  const rest = accounts.filter((account) => account !== selected);
  const owned = rest.filter(canCreateIn);
  const memberOnly = rest.filter((account) => !canCreateIn(account));
  return selected ? [selected, ...owned, ...memberOnly] : [...owned, ...memberOnly];
}

/**
 * Resolve the project to open.
 *
 * `lastProjectId` is untrusted (local storage): it wins only if the server
 * still lists it in one of the user's accounts. A project that was deleted,
 * archived, or lost access falls through to the first project.
 *
 * Throws only when every account's project list failed, so the caller retries
 * instead of opening the list on a network error.
 */
export async function resolveLandingProject(input: {
  accounts: KortixAccount[];
  selectedAccountId: string | null;
  lastProjectId: string | null;
  listProjects: (accountId: string) => Promise<KortixProject[]>;
}): Promise<LandingResolution> {
  const candidates = orderLandingAccounts(input.accounts, input.selectedAccountId);
  const lists = new Map<string, KortixProject[]>();

  const settled = await Promise.allSettled(
    candidates.map(async (account) => {
      lists.set(account.account_id, await input.listProjects(account.account_id));
    })
  );
  const failures = settled.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  if (candidates.length > 0 && failures.length === candidates.length) {
    throw failures[0].reason;
  }

  if (input.lastProjectId) {
    for (const account of candidates) {
      const remembered = lists
        .get(account.account_id)
        ?.find((project) => project.project_id === input.lastProjectId);
      if (remembered) {
        return { kind: 'project', projectId: remembered.project_id, accountId: account.account_id };
      }
    }
  }

  for (const account of candidates) {
    const first = lists.get(account.account_id)?.[0];
    if (first) return { kind: 'project', projectId: first.project_id, accountId: account.account_id };
  }

  return { kind: 'empty' };
}
