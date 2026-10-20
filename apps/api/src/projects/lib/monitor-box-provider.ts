/**
 * Which runtime hosts a monitor box, and whether this deployment can host one
 * at all. Its own module so the reconciler and the provisioner can share one
 * answer without the reconciler importing the provisioner's heavy subtree.
 */

import { config } from '../../config';
import type { ProviderName } from '../../platform/providers';

/**
 * Only Platinum honors `autoStopInterval: 0` → `type: 'persistent'`. Daytona
 * clamps auto-stop to ≥1 min, so it cannot host
 * a 24/7 watcher. This mirrors the `monitors` feature flag's
 * `available: () => Boolean(config.PLATINUM_API_KEY)`.
 */
export const MONITOR_PROVIDER: ProviderName = 'platinum';

export function monitorProviderConfigured(): boolean {
  return (
    !!config.PLATINUM_API_KEY &&
    (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(MONITOR_PROVIDER)
  );
}
