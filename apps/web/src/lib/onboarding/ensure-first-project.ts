import { type KortixProject, listProjectsForAccount, provisionProject } from '@kortix/sdk';

import { isValidProjectId } from '@/lib/onboarding/landing-destination';

export type FirstProjectAutoCreateState = {
  activeAccountId: string | null;
  canCreateProjects: boolean;
  autoCreateAttempted: boolean;
  accountsLoading: boolean;
  projectsLoading: boolean;
  projectsError: boolean;
  projectsLoaded: boolean;
  projectCount: number;
  legacyMachinesLoaded: boolean;
  legacyMachineCount: number;
  billingEnabled: boolean;
  accountStateLoading: boolean;
  canRun: boolean;
  suppressedAfterDelete: boolean;
};

/** Name + template for every auto-provisioned first project. */
export const FIRST_PROJECT_NAME = 'My First Project';
export const FIRST_PROJECT_TEMPLATE = 'general-knowledge-worker';

/**
 * Set when the user archives their LAST project. Auto-provisioning is otherwise
 * unconditional, and without this flag deleting your only project would
 * immediately recreate it — the app undoing the action the user just took.
 * Tab-scoped on purpose: the suppression is about *this* deliberate delete, so a
 * later sign-in or a fresh tab provisions again like any other empty account.
 */
const SUPPRESS_AUTO_PROJECT_KEY = 'kortix:suppress-auto-project';

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Private browsing / blocked storage — fall back to "not suppressed".
    return null;
  }
}

export function suppressAutoProjectAfterDelete(): void {
  safeSessionStorage()?.setItem(SUPPRESS_AUTO_PROJECT_KEY, '1');
}

export function isAutoProjectSuppressed(): boolean {
  return safeSessionStorage()?.getItem(SUPPRESS_AUTO_PROJECT_KEY) === '1';
}

export function clearAutoProjectSuppression(): void {
  safeSessionStorage()?.removeItem(SUPPRESS_AUTO_PROJECT_KEY);
}

/**
 * Whether this navigation may CREATE a project, as opposed to only opening one
 * that already exists.
 *
 * Provisioning mints a real managed git repository, so a cross-site link must
 * not trigger it just because the visitor happens to be signed in (CWE-352).
 * Both auto-provisioning entry points — the landing door and the empty projects
 * list — gate creation on this. Opening an EXISTING project stays allowed from
 * anywhere.
 *
 * A same-origin referrer covers the real entry points (`/auth/callback`, `/`,
 * in-app links). An EMPTY referrer covers a typed URL or a bookmark, which is
 * genuine user intent. A referrer naming another origin is what we refuse.
 *
 * This is defense in depth, not a complete control: an attacker can send
 * `referrerpolicy="no-referrer"` and be indistinguishable from a typed
 * navigation. What bounds the residual risk is that creation only ever fires
 * for an account with ZERO projects, and the free tier caps such an account at
 * one project anyway — so the worst case is the user getting the project that
 * sign-up would have created for them regardless.
 */
export function navigationMayCreateProject(): boolean {
  if (typeof document === 'undefined') return false;
  const referrer = document.referrer;
  if (!referrer) return true;
  try {
    return new URL(referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function isProjectLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('project_limit_reached') || message.includes('Free accounts are limited to')
  );
}

/**
 * True for the 503 `POST /projects/provision` returns when no managed-git
 * backend is configured (e.g. self-host with no MANAGED_GIT_* set) — an
 * EXPECTED, operator-fixable state, not a bug. Checks the status code first
 * (ApiError carries `.status`) and falls back to the message text for any
 * caller that only has a plain Error.
 */
export function isManagedGitUnavailableError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 503) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('is not configured on this server');
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

/**
 * Return the project this account should open, creating one when the account
 * has none.
 *
 * This deliberately provisions. The previous behaviour returned null for an
 * empty account and made the UI open the create-project modal, on the reasoning
 * that repository ownership is a user choice. That reasoning no longer holds:
 * sign-up already provisions a managed repo server-side, so the modal was a
 * manual step that only ever appeared when the automatic path had failed. The
 * BYO-repo choice stays available from the create flow.
 */
export async function ensureFirstProject(
  accountId: string,
  opts: { preferredProjectId?: string | null; allowCreate?: boolean } = {},
): Promise<KortixProject | null> {
  const existing = await listProjectsForAccount(accountId);
  const picked = pickLandingProject(existing, opts.preferredProjectId);
  if (picked) return picked;
  if (opts.allowCreate === false) return null;

  try {
    return await provisionProject({
      account_id: accountId,
      name: FIRST_PROJECT_NAME,
      seed_starter: true,
      starter_template: FIRST_PROJECT_TEMPLATE,
    });
  } catch (err) {
    // Losing a race (another tab provisioned first) and hitting the free-tier
    // cap look identical from here: the account now HAS a project, so re-read
    // instead of surfacing an error the user cannot act on.
    if (isProjectLimitError(err)) {
      const retry = await listProjectsForAccount(accountId);
      const retryPicked = pickLandingProject(retry, opts.preferredProjectId);
      if (retryPicked) return retryPicked;
    }
    throw err;
  }
}

export function shouldAutoCreateFirstProject(state: FirstProjectAutoCreateState): boolean {
  if (!state.activeAccountId || !state.canCreateProjects) return false;
  if (state.autoCreateAttempted) return false;
  if (state.suppressedAfterDelete) return false;
  if (state.accountsLoading || state.projectsLoading || state.projectsError) return false;
  if (!state.projectsLoaded) return false;
  if (state.projectCount > 0) return false;
  if (state.legacyMachinesLoaded && state.legacyMachineCount > 0) return false;

  if (state.billingEnabled) {
    if (state.accountStateLoading) return false;
    if (!state.canRun) return false;
  }

  return true;
}
