import type { AuthedPrincipal } from './principal';
import type { UpstreamDescriptor } from './descriptor';
import type { UsageEvent } from './usage';
import type { GatewayTrace } from './trace';
import type { ModelCatalog } from './catalog';

export interface GatewayHooks {
  authenticate: (token: string) => Promise<AuthedPrincipal | null>;
  resolveUpstream: (
    principal: AuthedPrincipal,
    model: string,
  ) => Promise<UpstreamDescriptor[]>;
  assertBillingActive: (accountId: string) => Promise<void>;
  assertBudget?: (principal: AuthedPrincipal) => Promise<void>;
  recordUsage: (event: UsageEvent) => Promise<void>;
  recordTrace?: (trace: GatewayTrace) => Promise<void>;
  listModels?: (principal: AuthedPrincipal) => Promise<ModelCatalog>;
}
