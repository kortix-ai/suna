import {
  listProjectsForAccount,
  provisionProject,
  type KortixProject,
} from '@/lib/projects-client';

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
    searchParams.get('team_signup') === 'success' ||
    searchParams.get('auth_event') === 'signup'
  );
}

export function isProjectLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('project_limit_reached') ||
    message.includes('Free accounts are limited to 1 project')
  );
}

/**
 * Return the account's first project, creating "My First Project" when none
 * exist. If the free-tier cap is already consumed, recover by listing again
 * and returning the existing project instead of surfacing a dead-end error.
 */
export async function ensureFirstProject(
  accountId: string,
): Promise<KortixProject | null> {
  const existing = await listProjectsForAccount(accountId);
  if (existing.length > 0) return existing[0] ?? null;

  try {
    return await provisionProject({ account_id: accountId, name: 'My First Project' });
  } catch (err) {
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
