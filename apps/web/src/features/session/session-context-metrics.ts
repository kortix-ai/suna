import { PROVIDER_LABELS } from '@kortix/llm-catalog';
import { getSessionCost, type ModelPricingLookup, type SessionLogMessage } from '@kortix/sdk';
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
  context: ContextMetrics | undefined;
}

/** A reply: an assistant message, or a compaction (its summary reply's usage is on it). */
export function isReply(m: SessionLogMessage): boolean {
  return m.role === 'assistant' || m.kind === 'compaction';
}

function tokenTotal(m: SessionLogMessage) {
  const u = m.usage;
  if (!u) return 0;
  return u.input + u.output + (u.reasoning ?? 0) + u.cache_read + u.cache_write;
}

/**
 * What the session billed for `messages`, through the SDK's one pricing
 * function. `getSessionCost` reads v1 shapes, so each reply with usage goes
 * in as one step: the reported cost wins, else the tokens price through the
 * lookup, times the markup — the same rule as for a v1 step-finish part.
 */
export function sessionLogCost(messages: SessionLogMessage[], lookup: ModelPricingLookup): number {
  const rows = messages.flatMap((m) => {
    if (!isReply(m) || !m.usage) return [];
    const u = m.usage;
    const tokens = { input: u.input, output: u.output, reasoning: u.reasoning ?? 0, cache: { read: u.cache_read, write: u.cache_write } };
    return [{
      info: { role: 'assistant', providerID: m.model?.provider, modelID: m.model?.model },
      parts: [{ type: 'step-finish', cost: u.cost ?? 0, tokens }],
    }];
  });
  return getSessionCost(rows as never, lookup);
}

/** Pure token math for the modal — exported for characterization tests. */
export function getSessionContextMetrics(
  messages: SessionLogMessage[],
  providers: ProviderListResponse | undefined,
  pricingLookup: ModelPricingLookup,
): Metrics {
  const totalCost = sessionLogCost(messages, pricingLookup);

  // Find the last reply with tokens
  let last: SessionLogMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isReply(m) || tokenTotal(m) <= 0) continue;
    last = m;
    break;
  }
  if (!last) return { totalCost, context: undefined };

  const providerID = last.model?.provider ?? '';
  const modelID = last.model?.model ?? '';
  const provider = providers?.all?.find((p) => p.id === providerID);
  const model = provider?.models?.[modelID];
  const modelProvider = model && 'provider' in model && typeof model.provider === 'string'
    ? model.provider
    : undefined;
  const limit = model?.limit?.context;
  const total = tokenTotal(last);

  // The gateway registers every model under the single synthetic `kortix`
  // opencode provider, so `provider.name` is always "Kortix" — even for a
  // BYOK Anthropic/Bedrock/OpenAI model. The gateway separately serves the
  // REAL upstream provider on the model itself (`model.provider`, e.g.
  // "anthropic"); prefer that for display, same fallback order as
  // `pickerGroupId`/`pickerGroupLabel` in ./model-grouping.ts.
  const upstreamProviderId = providerID === 'kortix' && modelProvider ? modelProvider : providerID;

  return {
    totalCost,
    context: {
      message: last,
      providerLabel: PROVIDER_LABELS[upstreamProviderId] ?? provider?.name ?? providerID,
      modelLabel: model?.name ?? modelID,
      limit,
      input: last.usage?.input ?? 0,
      output: last.usage?.output ?? 0,
      reasoning: last.usage?.reasoning ?? 0,
      cacheRead: last.usage?.cache_read ?? 0,
      cacheWrite: last.usage?.cache_write ?? 0,
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  };
}

/**
 * How many messages the thread holds, by role. A compaction message folds the
 * v1 marker and its summary reply into one record; it counts as the user
 * marker plus, once a summary reply exists, that assistant reply, so the
 * numbers match what the raw messages explorer lists.
 */
export function messageCounts(messages: SessionLogMessage[]): { all: number; user: number; assistant: number } {
  let user = 0;
  let assistant = 0;
  for (const m of messages) {
    if (m.role === 'user') user++;
    else if (m.role === 'assistant') assistant++;
    if (m.kind === 'compaction' && m.status !== 'streaming') assistant++;
  }
  return { all: user + assistant, user, assistant };
}
