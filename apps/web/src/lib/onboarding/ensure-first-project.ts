import {
  listProjectsForAccount,
  provisionProject,
  type KortixProject,
} from '@/lib/projects-client';

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
