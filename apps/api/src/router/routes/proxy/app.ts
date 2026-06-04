import { makeOpenApiApp } from '../../../openapi';
import { getProxyServices } from '../../config/proxy-services';
import { type ActorContext } from '../../../shared/actor-context';

// Catch-all billed proxy. Every route here is a Hono `.all()` (concrete method
// unknown at definition time → cannot use createRoute), so these intentionally do
// NOT appear in the OpenAPI spec. We still use makeOpenApiApp for a consistent app
// type across the router so `.route('/', proxy)` composes with the other sub-apps.
const proxy = makeOpenApiApp();

const services = getProxyServices();

interface LlmCreditReservation {
  accountId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  actor?: ActorContext | null;
  actorReservedCents?: number;
}

interface ToolCreditReservation {
  accountId: string;
  billingToolName: string;
  cost: number;
  actor?: ActorContext | null;
  actorReservedCents?: number;
}

interface AuthResult {
  isKortixUser: boolean;
  accountId?: string;
  /** True when the user's own API key is in Authorization (passthrough) but we identified the account via X-Kortix-Token. */
  isPassthrough?: boolean;
}

export { proxy, services };
export type { LlmCreditReservation, ToolCreditReservation, AuthResult };
