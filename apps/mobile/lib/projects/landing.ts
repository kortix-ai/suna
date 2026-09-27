/**
 * Where the app opens: the project the user had open last, else the first
 * project. Never the Projects list — the app does not drop the user there;
 * the project drawer's switcher is how they move between projects.
 *
 * The last project opens at once, before any request (`app/index.tsx`); the
 * server's lists confirm it in the background (`checkLastProject`). With no
 * last project the start screen resolves one over the network
 * (`resolveLandingProject`), and falls back to the lists this device kept
 * when the network fails (`freshOrCached`).
 *
 * Mirror of web's `/projects/start` resolver
 * (apps/web/src/lib/onboarding/resolve-landing-destination.ts) without
 * auto-provisioning: with no project in any account the caller opens the
 * first-run upgrade screen or `/new` (`startDestination`,
 * lib/onboarding/onboarding.ts).
 *
 * Pure: the project lists come in through `listProjects`, so tests pass plain
 * fakes instead of module-mocking the SDK.
 */

import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';
import { classifyStartFailure } from '@/lib/projects/start-failure';

export type LandingResolution =
  | { kind: 'project'; projectId: string; accountId: string }
  | { kind: 'empty' };

function canCreateIn(account: KortixAccount): boolean {
  return account.account_role === 'owner' || account.account_role === 'admin';
}

/**
 * The accounts a project can be created in: owner or admin, in the given
 * order. Web's `filterCreatableAccounts` (`features/workspace/new`).
 */
export function creatableAccounts(accounts: KortixAccount[]): KortixAccount[] {
  return accounts.filter(canCreateIn);
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
 * instead of opening `/new` on a network error.
 */
export async function resolveLandingProject(input: {
  accounts: KortixAccount[];
  selectedAccountId: string | null;
  lastProjectId: string | null;
  listProjects: (accountId: string) => Promise<KortixProject[]>;
}): Promise<LandingResolution> {
  const candidates = orderLandingAccounts(input.accounts, input.selectedAccountId);
  const { lists, failures } = await loadProjectLists(candidates, input.listProjects);
  if (candidates.length > 0 && failures.length === candidates.length) {
    throw failures[0];
  }

  if (input.lastProjectId) {
    const accountId = accountListing(candidates, lists, input.lastProjectId);
    if (accountId) return { kind: 'project', projectId: input.lastProjectId, accountId };
  }

  for (const account of candidates) {
    const first = lists.get(account.account_id)?.[0];
    if (first) return { kind: 'project', projectId: first.project_id, accountId: account.account_id };
  }

  return { kind: 'empty' };
}

/**
 * What the server's lists say about the project that opened blind.
 *
 * - `listed`: an account lists it. Stay, with that account selected.
 * - `gone`: every account answered and none lists it — deleted, archived,
 *   or access lost. Forget it and resolve again.
 * - `unknown`: no loaded list has it, but a list failed. The project may be
 *   in the account that did not answer: keep the user where they are.
 */
export type LastProjectCheck =
  | { kind: 'listed'; accountId: string }
  | { kind: 'gone' }
  | { kind: 'unknown' };

export async function checkLastProject(input: {
  accounts: KortixAccount[];
  selectedAccountId: string | null;
  lastProjectId: string;
  listProjects: (accountId: string) => Promise<KortixProject[]>;
}): Promise<LastProjectCheck> {
  const candidates = orderLandingAccounts(input.accounts, input.selectedAccountId);
  const { lists, failures } = await loadProjectLists(candidates, input.listProjects);
  const accountId = accountListing(candidates, lists, input.lastProjectId);
  if (accountId) return { kind: 'listed', accountId };
  return failures.length > 0 ? { kind: 'unknown' } : { kind: 'gone' };
}

/**
 * A fresh answer, or the one this device kept (the persisted query cache,
 * lib/query) when the request fails. Never the kept one for an ended login
 * (401/403): signing in again is the only way on, and the start screen says so.
 */
export async function freshOrCached<T>(
  fetch: () => Promise<T>,
  cached: () => T | undefined
): Promise<T> {
  try {
    return await fetch();
  } catch (error) {
    const kept = classifyStartFailure(error) === 'session' ? undefined : cached();
    if (kept !== undefined) return kept;
    throw error;
  }
}

/** Every account's project list, in parallel; a failed list is reported, not thrown. */
async function loadProjectLists(
  accounts: KortixAccount[],
  listProjects: (accountId: string) => Promise<KortixProject[]>
): Promise<{ lists: Map<string, KortixProject[]>; failures: unknown[] }> {
  const lists = new Map<string, KortixProject[]>();
  const settled = await Promise.allSettled(
    accounts.map(async (account) => {
      lists.set(account.account_id, await listProjects(account.account_id));
    })
  );
  const failures = settled.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
  return { lists, failures };
}

/** The first account, in landing order, whose loaded list has the project. */
function accountListing(
  accounts: KortixAccount[],
  lists: Map<string, KortixProject[]>,
  projectId: string
): string | null {
  const account = accounts.find((candidate) =>
    lists.get(candidate.account_id)?.some((project) => project.project_id === projectId)
  );
  return account?.account_id ?? null;
}
