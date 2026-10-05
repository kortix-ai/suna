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
