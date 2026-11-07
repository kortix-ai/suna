import { stripNullBytes, stripNullBytesDeep } from '@kortix/shared';

export interface GatewayTraceInput {
  requestId: string;
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
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
  cacheWriteTokens?: number;
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

// metadata is an INCLUDE column of idx_gateway_logs_project_time_covering_v2,
// so it lives in a btree tuple (max ~2.7 KB): an oversized value fails the
// INSERT of the whole trace row. attemptFailures carries upstream error text,
// the one unbounded part; shrink it tier by tier until the metadata fits.
const METADATA_MAX_BYTES = 2000;
const FAILURE_TIERS = [
  { keep: 8, chars: 160 },
  { keep: 3, chars: 60 },
  { keep: 1, chars: 20 },
] as const;

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const clip = (value: unknown, chars: number) => (typeof value === 'string' ? Array.from(value).slice(0, chars).join('') : value);

function boundMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  if (byteLength(metadata) <= METADATA_MAX_BYTES) return metadata;
  const { attemptFailures, ...rest } = metadata;
  if (Array.isArray(attemptFailures)) {
    for (const { keep, chars } of FAILURE_TIERS) {
      const shrunk = attemptFailures.slice(0, keep).map((failure) =>
        failure && typeof failure === 'object'
          ? Object.fromEntries(Object.entries(failure).map(([key, value]) => [key, clip(value, chars)]))
          : failure,
      );
      const candidate = { ...rest, attemptFailures: shrunk };
      if (byteLength(candidate) <= METADATA_MAX_BYTES) return candidate;
    }
  }
  return rest;
}

function asJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (value === undefined || value === null) return null;
  return { value };
}

/**
 * Build the gateway_request_logs row, scrubbing NUL characters (U+0000) from
 * every free-form payload first.
 *
 * The request/response bodies (and occasionally `metadata` or the upstream
 * `errorMessage`) carry raw LLM conversation content that can contain U+0000 —
 * from binary file reads, raw terminal output, or truncated tool results.
 * Postgres rejects U+0000 in both `jsonb` and `text` columns: a jsonb value
 * whose JSON text holds the U+0000 escape fails at parse time with
 * `22P05 unsupported Unicode escape sequence`. Because the trace write is
 * best-effort (fire-and-forget in the pipeline), an unscrubbed NUL doesn't fail
 * the LLM call — it silently drops the trace and spams the error logs on every
 * affected request. Stripping here keeps the write from ever throwing.
 *
 * Pure (no DB import) so the sanitization is unit-testable in isolation.
 */
export function buildGatewayTraceRow(input: GatewayTraceInput) {
  return {
    requestId: input.requestId,
    accountId: input.accountId,
    projectId: input.projectId || null,
    sessionId: input.sessionId || null,
    actorUserId: input.actorUserId || null,
    keyId: input.keyId || null,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    provider: input.provider,
    status: input.status,
    ok: input.ok,
    errorCode: input.errorCode || null,
    errorMessage: input.errorMessage ? stripNullBytes(input.errorMessage) : null,
    latencyMs: nonNegInt(input.latencyMs),
    attempts: nonNegInt(input.attempts),
    candidatesTried: stripNullBytesDeep(input.candidatesTried ?? []),
    inputTokens: nonNegInt(input.promptTokens),
    outputTokens: nonNegInt(input.completionTokens),
    cachedTokens: nonNegInt(input.cachedTokens),
    cacheWriteTokens: nonNegInt(input.cacheWriteTokens),
    upstreamCost: String(input.upstreamCost ?? 0),
    finalCost: String(input.finalCost ?? 0),
    streaming: input.streaming ?? false,
    billingMode: input.billingMode || null,
    request: stripNullBytesDeep(asJson(input.request)),
    response: stripNullBytesDeep(asJson(input.response)),
    metadata: boundMetadata(stripNullBytesDeep(input.metadata ?? {})),
  };
}
