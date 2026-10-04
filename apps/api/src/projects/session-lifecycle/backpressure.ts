import { config } from '../../lib/config';
import { countProvisioningProjectSessions } from '../lib/sessions';

export function triggerBackpressureLimit() {
  const configured = Number((config as any).KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

export async function sessionBackpressureState(projectId: string) {
  const provisioning = await countProvisioningProjectSessions(projectId);
  const projectProvisioningLimit = triggerBackpressureLimit();
  const shouldQueue = provisioning >= projectProvisioningLimit;
  return {
    shouldQueue,
    provisioning,
    projectProvisioningLimit,
    reason: shouldQueue ? 'project provisioning backpressure' : null,
  };
}
