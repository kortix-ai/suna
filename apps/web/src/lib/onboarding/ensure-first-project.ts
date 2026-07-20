import { listProjectsForAccount, type KortixProject } from '@kortix/sdk/projects-client';

export type FirstProjectAutoCreateState = {
  bootstrapRequested: boolean;
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
};

export function hasFirstProjectBootstrapSignal(searchParams: URLSearchParams): boolean {
  return (
    searchParams.get('team_signup') === 'success' || searchParams.get('auth_event') === 'signup'
  );
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
 * Return the account's first project. Empty accounts deliberately return null:
 * repository ownership is a user choice, so onboarding opens the create flow
 * and asks for a GitHub App installation (preferred) or explicit managed Git.
 */
export async function ensureFirstProject(accountId: string): Promise<KortixProject | null> {
  const existing = await listProjectsForAccount(accountId);
  return existing[0] ?? null;
}

export function shouldAutoCreateFirstProject(state: FirstProjectAutoCreateState): boolean {
  if (!state.bootstrapRequested) return false;
  if (!state.activeAccountId || !state.canCreateProjects) return false;
  if (state.autoCreateAttempted) return false;
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
