import { type KortixAccount, type KortixProject, listProjectsForAccount } from '@kortix/sdk';

import { isValidProjectId } from '@/lib/onboarding/landing-destination';

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
 *
 * It never creates a project. With nothing to open, the door renders the
 * chooser: the user's pending invites and, when allowed, a create action. An
 * invitee who signed up without the email link used to land in an
 * auto-created "My First Project" with no sign of the invite.
 */
export type LandingResolution =
  | { kind: 'project'; project: KortixProject; accountId: string }
  /** No project anywhere. `canCreate` is for the primary candidate account —
   *  the user's active workspace context — and decides whether the chooser
   *  offers a create action. */
  | { kind: 'terminal'; canCreate: boolean };

/** The one network call the resolver makes, injectable for tests. */
export type LandingClient = {
  listProjectsForAccount: (accountId: string) => Promise<KortixProject[]>;
};

export async function resolveLandingDestination(input: {
  accounts: KortixAccount[];
  selectedAccountId: string | null;
  preferredProjectId?: string | null;
  client?: LandingClient;
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

  // Nothing to open anywhere. Create permission is judged on the PRIMARY
  // candidate only — the selected workspace when it is still a membership,
  // else the first account the user owns. Flow-08 contract: a member whose
  // project access was just revoked, with that org selected, is told to ask
  // an admin; the chooser does not offer to create in another account.
  const primary = candidates[0];
  return { kind: 'terminal', canCreate: primary !== undefined && canCreateIn(primary) };
}

/**
 * Pick which existing project to open: the one the browser last had open, else
 * the first. `preferredProjectId` is untrusted (it comes from a cookie), so it
 * only ever selects from the list the server already said this account owns.
 */
export function pickLandingProject(
  projects: KortixProject[],
  preferredProjectId?: string | null,
): KortixProject | null {
  if (projects.length === 0) return null;
  if (isValidProjectId(preferredProjectId)) {
    const preferred = projects.find((project) => project.project_id === preferredProjectId);
    if (preferred) return preferred;
  }
  return projects[0] ?? null;
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
