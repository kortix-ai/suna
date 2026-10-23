import { PROVIDER_LABELS } from '@kortix/llm-catalog';
import { sessionLogThreadMetrics, type ModelPricingLookup, type SessionLogMessage, type SessionLogThread, type SessionLogThreadMetrics } from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';

// ============================================================================
// Context metrics
// ============================================================================

interface ContextMetrics {
  /** The reply the numbers come from: the last one with usage. */
  message: SessionLogMessage;
  providerLabel: string;
  modelLabel: string;
  limit: number | undefined;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  usage: number | null;
}

interface Metrics {
  totalCost: number;
  messages: SessionLogThreadMetrics['messages'];
  context: ContextMetrics | undefined;
}

/** Pure token math for the modal — exported for characterization tests. */
export function getSessionContextMetrics(
  thread: SessionLogThread | null,
  providers: ProviderListResponse | undefined,
  pricingLookup: ModelPricingLookup,
): Metrics {
  if (!thread) return { totalCost: 0, messages: { all: 0, user: 0, assistant: 0 }, context: undefined };
  const { cost: totalCost, messages, context: last } = sessionLogThreadMetrics(thread, { pricing: pricingLookup });
  if (!last?.usage) return { totalCost, messages, context: undefined };
  const u = last.usage;

  const providerID = last.model?.provider ?? '';
  const modelID = last.model?.model ?? '';
  const provider = providers?.all?.find((p) => p.id === providerID);
  const model = provider?.models?.[modelID];
  const modelProvider = model && 'provider' in model && typeof model.provider === 'string'
    ? model.provider
    : undefined;
  const limit = model?.limit?.context;
  const total = u.input + u.output + (u.reasoning ?? 0) + u.cache_read + u.cache_write;

  // The gateway registers every model under the single synthetic `kortix`
  // opencode provider, so `provider.name` is always "Kortix" — even for a
  // BYOK Anthropic/Bedrock/OpenAI model. The gateway separately serves the
  // REAL upstream provider on the model itself (`model.provider`, e.g.
  // "anthropic"); prefer that for display, same fallback order as
  // `pickerGroupId`/`pickerGroupLabel` in ./model-grouping.ts.
  const upstreamProviderId = providerID === 'kortix' && modelProvider ? modelProvider : providerID;

  return {
    totalCost,
    messages,
    context: {
      message: last,
      providerLabel: PROVIDER_LABELS[upstreamProviderId] ?? provider?.name ?? providerID,
      modelLabel: model?.name ?? modelID,
      limit,
      input: u.input,
      output: u.output,
      reasoning: u.reasoning ?? 0,
      cacheRead: u.cache_read,
      cacheWrite: u.cache_write,
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  };
}

/**
 * When the session started. The session row's creation, when the runtime is the row's root (or
 * not up): a pi box stamps its runtime session at boot, so a woken session's runtime time is after
 * its last reply. A sub-agent's runtime (not the row's root) keeps its own time.
 */
export function sessionStartedAt(
  runtime: { id: string; time: { created: number } } | undefined,
  row: { created_at: string; runtime_session_id?: string | null; opencode_session_id?: string | null } | null | undefined,
): number | undefined {
  const own = row && (!runtime || (row.runtime_session_id ?? row.opencode_session_id) === runtime.id);
  return own ? Date.parse(row.created_at) : runtime?.time.created;
}
