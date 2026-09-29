import { gatewayRequestLogs } from '@kortix/db';
import { splitLlmSpend } from '../../shared/llm-spend';

// The gateway log wire projection: the column map and row serializer the log
// list and log detail routes share.

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

export const LIST_COLUMNS = {
  logId: gatewayRequestLogs.logId,
  requestId: gatewayRequestLogs.requestId,
  createdAt: gatewayRequestLogs.createdAt,
  requestedModel: gatewayRequestLogs.requestedModel,
  resolvedModel: gatewayRequestLogs.resolvedModel,
  provider: gatewayRequestLogs.provider,
  status: gatewayRequestLogs.status,
  ok: gatewayRequestLogs.ok,
  errorCode: gatewayRequestLogs.errorCode,
  errorMessage: gatewayRequestLogs.errorMessage,
  latencyMs: gatewayRequestLogs.latencyMs,
  attempts: gatewayRequestLogs.attempts,
  inputTokens: gatewayRequestLogs.inputTokens,
  outputTokens: gatewayRequestLogs.outputTokens,
  cachedTokens: gatewayRequestLogs.cachedTokens,
  cacheWriteTokens: gatewayRequestLogs.cacheWriteTokens,
  upstreamCost: gatewayRequestLogs.upstreamCost,
  finalCost: gatewayRequestLogs.finalCost,
  streaming: gatewayRequestLogs.streaming,
  billingMode: gatewayRequestLogs.billingMode,
  actorUserId: gatewayRequestLogs.actorUserId,
  keyId: gatewayRequestLogs.keyId,
};

export function serializeLogRow(r: Record<string, any>) {
  // See shared/llm-spend.ts. `final_cost` alone answers "what did Kortix bill
  // you", which is 0 on every BYOK request — it is not what the call cost you.
  const spend = splitLlmSpend({
    billingMode: r.billingMode,
    upstreamCost: r.upstreamCost,
    finalCost: r.finalCost,
  });
  return {
    log_id: r.logId,
    request_id: r.requestId,
    created_at: r.createdAt,
    requested_model: r.requestedModel,
    resolved_model: r.resolvedModel,
    provider: r.provider,
    status: r.status,
    ok: r.ok,
    error_code: r.errorCode,
    error_message: r.errorMessage,
    latency_ms: r.latencyMs,
    attempts: r.attempts,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cached_tokens: r.cachedTokens,
    cache_write_tokens: r.cacheWriteTokens,
    // What you paid your own provider, and what Kortix debited from your
    // wallet. On a Kortix-managed (`credits`) row `provider_cost` is 0 on
    // purpose: the upstream price there is Kortix's wholesale cost, not
    // yours, and shipping it would publish the Kortix margin on every
    // managed request.
    kortix_cost: spend.kortix_cost,
    provider_cost: spend.provider_cost,
    total_cost: spend.total_cost,
    /** @deprecated Same value as `provider_cost`. */
    upstream_cost: spend.provider_cost,
    /** @deprecated Same value as `kortix_cost`. */
    final_cost: spend.kortix_cost,
    streaming: r.streaming,
    billing_mode: r.billingMode,
    actor_user_id: r.actorUserId,
    key_id: r.keyId,
  };
}
