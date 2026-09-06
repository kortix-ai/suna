import { type KortixAccount, type KortixProject, listProjectsForAccount } from '@kortix/sdk';

import {
  type EnsureFirstProjectClient,
  ensureFirstProject,
  pickLandingProject,
} from '@/lib/onboarding/ensure-first-project';

/**
 * The landing door's one decision: which project to open, across EVERY
 * account the user belongs to.
 *
 * `/projects/start` used to resolve a single account — `find(selectedAccountId)
 * ?? accounts[0]` — and treat that account's emptiness as the user's emptiness.
 * A stale persisted selection (a team where the user is a plain member with no
 * project grants) or a nondeterministic `accounts[0]` then rendered "No
 * workspace yet" while the user's personal account, in the same list, held
 * their projects. This resolver only concludes "nothing to open" after it has
 * looked at every membership.
 */
export type LandingResolution =
  | { kind: 'project'; project: KortixProject; accountId: string }
  /** No project anywhere. `canCreate` (of the primary candidate account —
   *  the user's active workspace context) feeds `classifyLandingTerminal`.
   *  `suppressed` is scoped to that SAME primary candidate — never "any
   *  account this user owns" — see the doc comment above `creator` below. */
  | { kind: 'terminal'; canCreate: boolean; suppressed: boolean };

export async function resolveLandingDestination(input: {
  accounts: KortixAccount[];
  selectedAccountId: string | null;
  preferredProjectId?: string | null;
  /**
   * `isAutoProjectSuppressed` — the user just archived THIS account's last
   * project. Applied to the ONE `creator` account this resolution actually
   * evaluates for auto-create (see below), never called for the others: a
   * flag scoped to account A must not suppress creation in an unrelated
   * account B just because the same user happens to own both. Pass
   * `isAutoProjectSuppressed` from `ensure-first-project.ts` directly — its
   * signature already matches.
   */
  isAccountSuppressed: (accountId: string) => boolean;
  /** `navigationMayCreateProject()` — this navigation proved create intent. */
  mayCreate: boolean;
  client?: EnsureFirstProjectClient;
}): Promise<LandingResolution> {
  const { accounts, selectedAccountId, preferredProjectId, client } = input;

  const candidates = orderCandidates(accounts, selectedAccountId);
  const projectLists = new Map<string, KortixProject[]>();
  // A transient failure on ONE membership must not demote the user to the
  // error screen when a different account resolves fine — a failed list reads
  // as empty here. Only when EVERY list failed is the error surfaced, so the
  // caller's retry loop still gets a real signal instead of a false terminal.
  const settled = await Promise.allSettled(
    candidates.map(async (entry) => {
      const list = await (client?.listProjectsForAccount ?? listProjectsForAccount)(
        entry.account_id,
      );
      projectLists.set(entry.account_id, list);
    }),
  );
  const failures = settled.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (candidates.length > 0 && failures.length === candidates.length) {
    throw failures[0].reason;
  }

  // Last-used first: the cookie names the exact project the user last had
  // open. If any account still lists it, that beats both the persisted
  // selection and the owner-first ordering below.
  if (preferredProjectId) {
    for (const entry of candidates) {
      const remembered = (projectLists.get(entry.account_id) ?? []).find(
        (candidate) => candidate.project_id === preferredProjectId,
      );
      if (remembered) return { kind: 'project', project: remembered, accountId: entry.account_id };
    }
  }

  for (const entry of candidates) {
    const picked = pickLandingProject(projectLists.get(entry.account_id) ?? [], preferredProjectId);
    if (picked) return { kind: 'project', project: picked, accountId: entry.account_id };
  }

  // Nothing to open anywhere. Auto-provision ONLY in the primary candidate
  // account — the selected workspace when it is still a membership, else the
  // first account the user owns. Reaching across from an explicitly selected
  // member workspace is forbidden by the flow-08 contract: a member whose
  // project access was just revoked must see the "No workspace yet" terminal,
  // not a surprise project minted in their personal account (which on a
  // self-host without managed git would be a guaranteed 503 anyway).
  const primary = candidates[0];
  const creator = primary && canCreateIn(primary) ? primary : undefined;
  // Evaluated for `creator.account_id` ONLY. `isAccountSuppressed` is
  // account-bound by design (`ensure-first-project.ts`), and this resolver
  // itself only ever gates auto-create for this ONE candidate — checking any
  // OTHER account here would suppress creation for an account nobody
  // archived anything on, just because the caller happens to own both.
  const suppressedForCreator = creator ? input.isAccountSuppressed(creator.account_id) : false;
  if (creator && input.mayCreate && !suppressedForCreator) {
    const created = await ensureFirstProject(
      creator.account_id,
      { preferredProjectId, allowCreate: true },
      client,
    );
    if (created) return { kind: 'project', project: created, accountId: creator.account_id };
  }

  return { kind: 'terminal', canCreate: creator !== undefined, suppressed: suppressedForCreator };
}

/** Owners/admins may create projects (ACCOUNT_ACTIONS.PROJECT_CREATE). */
function canCreateIn(account: KortixAccount): boolean {
  return account.account_role === 'owner' || account.account_role === 'admin';
}

/**
 * The order in which accounts are tried: the explicitly selected one first,
 * then accounts the user owns/administers, then plain memberships. Within a
 * group the server's list order is kept (stable sort), so the result is
 * deterministic even though `GET /v1/accounts` itself carries no ORDER BY.
 */
function orderCandidates(
  accounts: KortixAccount[],
  selectedAccountId: string | null,
): KortixAccount[] {
  const selected = accounts.find((entry) => entry.account_id === selectedAccountId);
  const rest = accounts.filter((entry) => entry !== selected);
  const owned = rest.filter(canCreateIn);
  const memberOnly = rest.filter((entry) => !canCreateIn(entry));
  return selected ? [selected, ...owned, ...memberOnly] : [...owned, ...memberOnly];
}
