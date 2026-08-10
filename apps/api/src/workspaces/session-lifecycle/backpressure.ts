import { config } from '../../config';
import { resolveAccountSessionLimit } from '../../shared/account-limits';
import { countActiveWorkspaceSessions, countProvisioningWorkspaceSessions } from '../lib/sessions';

export function triggerBackpressureLimit() {
  const configured = Number((config as any).KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_WORKSPACE);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

export async function sessionBackpressureState(accountId: string, workspaceId: string) {
  const [provisioning, active, sessionLimit] = await Promise.all([
    countProvisioningWorkspaceSessions(workspaceId),
    countActiveWorkspaceSessions(accountId),
    resolveAccountSessionLimit(accountId),
  ]);
  const { tier } = sessionLimit;
  const workspaceProvisioningLimit = triggerBackpressureLimit();
  const accountActiveLimit = sessionLimit.limit;
  return {
    shouldQueue: provisioning >= workspaceProvisioningLimit || active >= accountActiveLimit,
    provisioning,
    workspaceProvisioningLimit,
    active,
    accountActiveLimit,
    tier,
    reason:
      provisioning >= workspaceProvisioningLimit
        ? 'workspace provisioning backpressure'
        : active >= accountActiveLimit
          ? 'account session cap'
          : null,
  };
}
