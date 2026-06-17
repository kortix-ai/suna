import { config } from '../../config';
import { maxConcurrentSessionsForTier, resolveAccountTier } from '../../shared/account-limits';
import { countActiveProjectSessions, countProvisioningProjectSessions } from '../lib/sessions';

export function triggerBackpressureLimit() {
  const configured = Number((config as any).KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

export async function sessionBackpressureState(accountId: string, projectId: string) {
  const [provisioning, active, tier] = await Promise.all([
    countProvisioningProjectSessions(projectId),
    countActiveProjectSessions(accountId),
    resolveAccountTier(accountId),
  ]);
  const projectProvisioningLimit = triggerBackpressureLimit();
  const accountActiveLimit = maxConcurrentSessionsForTier(tier);
  return {
    shouldQueue: provisioning >= projectProvisioningLimit || active >= accountActiveLimit,
    provisioning,
    projectProvisioningLimit,
    active,
    accountActiveLimit,
    tier,
    reason:
      provisioning >= projectProvisioningLimit
        ? 'project provisioning backpressure'
        : active >= accountActiveLimit
          ? 'account session cap'
          : null,
  };
}
