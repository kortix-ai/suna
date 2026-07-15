import { listDefaultProjectMarketplaceItems } from '@/lib/marketplace-client';
import {
  listProjectsForAccount,
  provisionProject,
  type KortixProject,
} from '@kortix/sdk/projects-client';

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
 * Return the account's first project, creating "My First Project" when none
 * exist. If the free-tier cap is already consumed, recover by listing again
 * and returning the existing project instead of surfacing a dead-end error.
 * If managed git isn't configured on this server, there is nothing to
 * auto-create — return null so the caller falls back to its normal empty
 * "create a project" state instead of treating it as a hard failure.
 */
export async function ensureFirstProject(accountId: string): Promise<KortixProject | null> {
  const existing = await listProjectsForAccount(accountId);
  if (existing.length > 0) return existing[0] ?? null;

  try {
    const marketplaceItems = await listDefaultProjectMarketplaceItems();
    return await provisionProject({
      account_id: accountId,
      name: 'My First Project',
      starter_template: 'general-knowledge-worker',
      marketplace_items: marketplaceItems.map((item) => item.id),
    });
  } catch (err) {
    if (isManagedGitUnavailableError(err)) return null;
    if (!isProjectLimitError(err)) throw err;
    const retry = await listProjectsForAccount(accountId);
    return retry[0] ?? null;
  }
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
