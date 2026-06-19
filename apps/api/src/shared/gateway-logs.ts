import { gatewayRequestLogs } from '@kortix/db';
import { db } from './db';

export interface GatewayTraceInput {
  requestId: string;
  accountId: string;
  projectId?: string | null;
  actorUserId?: string | null;
  keyId?: string | null;
  requestedModel: string;
  resolvedModel: string;
  provider: string;
  status: number;
  ok: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  latencyMs?: number;
  attempts?: number;
  candidatesTried?: string[];
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  upstreamCost?: number;
  finalCost?: number;
  streaming?: boolean;
  billingMode?: string | null;
  request?: unknown;
  response?: unknown;
  metadata?: Record<string, unknown>;
}

function nonNegInt(value: number | undefined) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

function asJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (value === undefined || value === null) return null;
  return { value };
}

export async function recordGatewayTrace(input: GatewayTraceInput): Promise<void> {
  await db
    .insert(gatewayRequestLogs)
    .values({
      requestId: input.requestId,
      accountId: input.accountId,
      projectId: input.projectId || null,
      actorUserId: input.actorUserId || null,
      keyId: input.keyId || null,
      requestedModel: input.requestedModel,
      resolvedModel: input.resolvedModel,
      provider: input.provider,
      status: input.status,
      ok: input.ok,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      latencyMs: nonNegInt(input.latencyMs),
      attempts: nonNegInt(input.attempts),
      candidatesTried: input.candidatesTried ?? [],
      inputTokens: nonNegInt(input.promptTokens),
      outputTokens: nonNegInt(input.completionTokens),
      cachedTokens: nonNegInt(input.cachedTokens),
      upstreamCost: String(input.upstreamCost ?? 0),
      finalCost: String(input.finalCost ?? 0),
      streaming: input.streaming ?? false,
      billingMode: input.billingMode || null,
      request: asJson(input.request),
      response: asJson(input.response),
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({ target: gatewayRequestLogs.requestId });
}
