import type { GatewayAttemptFailure } from './failure';
import type { BillingMode } from './principal';
import type { TokenCounts } from './usage';

export interface GatewayTrace {
  requestId: string;
  startedAt: string;
  accountId: string;
  actorUserId: string;
  projectId?: string;
  sessionId?: string;
  keyId?: string;
  requestedModel: string;
  resolvedModel: string;
  provider: string;
  billingMode: BillingMode;
  streaming: boolean;
  status: number;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
  attempts: number;
  candidatesTried: string[];
  attemptFailures?: GatewayAttemptFailure[];
  /**
   * The route id of the model that answered, as a client names it
   * (`glm-5.3-flash`, `codex/gpt-6.1-sol`). `resolvedModel` is the upstream's
   * id for an own key or ChatGPT plan, so it cannot be compared with
   * `requestedModel`. Set on an answered request.
   */
  servedModel?: string;
  /** The model the route named, when a fallback model answered in its place. */
  fallbackFrom?: string;
  // The upstream behind a public identity (UpstreamDescriptor.publicProvider).
  // Staff-only: server logs and staff telemetry read it; hosts must never
  // persist it where customers can read it.
  upstream?: { provider: string; model: string };
  usage: TokenCounts;
  upstreamCost: number;
  finalCost: number;
  request: unknown;
  response: unknown;
  metadata: Record<string, unknown>;
}
