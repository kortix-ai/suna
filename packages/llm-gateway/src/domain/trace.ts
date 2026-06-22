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
  usage: TokenCounts;
  upstreamCost: number;
  finalCost: number;
  request: unknown;
  response: unknown;
  metadata: Record<string, unknown>;
}
