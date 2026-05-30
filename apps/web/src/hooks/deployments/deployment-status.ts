import type { DeploymentStatus } from './use-deployments';

/**
 * Statuses where a deployment is still changing and therefore worth polling.
 * `active` / `failed` / `stopped` are settled — they won't change without an
 * explicit user action (which already invalidates the query).
 */
const IN_PROGRESS_STATUSES: readonly DeploymentStatus[] = ['pending', 'building', 'deploying'];

export function isDeploymentInProgress(status: DeploymentStatus): boolean {
  return IN_PROGRESS_STATUSES.includes(status);
}

/**
 * True if any deployment is still in progress — i.e. background polling is
 * worthwhile. When every deployment is settled, polling should stop (a new
 * deployment re-triggers a fetch via mutation invalidation / window focus).
 */
export function shouldPollDeployments(
  deployments: readonly { status: DeploymentStatus }[] | undefined | null,
): boolean {
  return !!deployments?.some((d) => isDeploymentInProgress(d.status));
}
