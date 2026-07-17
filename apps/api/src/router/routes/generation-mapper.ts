/**
 * Pure row → response mapping for `GET /v1/generation`. Deliberately has NO
 * DB/config imports so it can be unit-tested without booting the API's env
 * validation (see generation.test.ts) — the route handler in ./generation.ts
 * is the only place this is wired to a live `gateway_request_logs` row.
 */

/**
 * The subset of a `gateway_request_logs` row this mapper needs — narrower than
 * the full Drizzle row type so it's trivial to unit-test without a DB.
 */
export interface GatewayLogRowForGeneration {
  requestId: string;
  resolvedModel: string;
  requestedModel: string;
  provider: string;
  streaming: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  finalCost: string | number;
  upstreamCost: string | number;
  latencyMs: number;
  attempts: number;
  status: number;
  ok: boolean;
  errorCode: string | null;
  createdAt: Date | string;
}

/**
 * Maps a `gateway_request_logs` row to the OpenRouter-parity `GET /v1/generation`
 * `{ data: {...} }` envelope.
 */
export function mapGatewayLogToGeneration(row: GatewayLogRowForGeneration) {
  return {
    id: row.requestId,
    model: row.resolvedModel,
    requested_model: row.requestedModel,
    provider: row.provider,
    streamed: row.streaming,
    tokens_prompt: row.inputTokens,
    tokens_completion: row.outputTokens,
    tokens_cached: row.cachedTokens,
    total_cost: Number(row.finalCost),
    upstream_cost: Number(row.upstreamCost),
    latency_ms: row.latencyMs,
    attempts: row.attempts,
    status: row.status,
    ok: row.ok,
    finish_reason: row.errorCode ?? null,
    created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}
