/**
 * Kind `convex`: a self-hosted Convex backend in its own persistent Platinum
 * machine, one per App (./provision.ts). Policy, owned here and nowhere else:
 *
 * - It never sleeps: the machine runs 24/7 (`always_on` is forced true).
 * - The monthly budget alerts at 80 % and 100 % and never stops the machine
 *   (./maintenance.ts budgetStep): a stopped database breaks every client.
 * - A delete needs the typed slug (`confirm`), takes a `final` snapshot,
 *   stops the machine and keeps it 7 days; the hosts answer 410 meanwhile
 *   (./operations.ts retireConvexApp, ./lifecycle.ts purgeRetiredConvexApps).
 * - Disk only grows on resize.
 * - Bound by a using App (`/_kortix/apps/<slug>/*`), it is its Convex client API.
 */
import type { AppCapability, AppKindModule } from '../index';
import { convexEndpointResponse, convexEndpointWsUpgrade } from './hosts';
import { sweepBackends } from './maintenance';

export const CONVEX_CAPABILITIES: readonly AppCapability[] = [
  'deployments',
  'snapshots',
  'restore',
  'admin_credentials',
  'dashboard',
  'logs',
  'member_tokens',
];

export const convexKind: AppKindModule = {
  capabilities: () => [...CONVEX_CAPABILITIES],
  maintain: async () => ({ ...(await sweepBackends()) }),
  // Bound, the Convex client API: what `new ConvexClient(binding.url)` speaks.
  endpoint: {
    fetch: (request, appId, path, publicHost) => convexEndpointResponse(request, appId, 'api', path, publicHost),
    websocket: (request, appId, path, publicHost) => convexEndpointWsUpgrade(request, appId, 'api', path, publicHost),
  },
};
