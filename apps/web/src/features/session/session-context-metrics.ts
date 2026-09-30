import type { MessageWithParts } from '@/ui/types';
import { PROVIDER_LABELS } from '@kortix/llm-catalog';
import { getSessionCost, type AssistantMessage, type ModelPricingLookup } from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';

// ============================================================================
// Context metrics
// ============================================================================

interface ContextMetrics {
  message: AssistantMessage;
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

function tokenTotal(msg: AssistantMessage) {
  if (!msg.tokens) return 0;
  const t = msg.tokens;
  return (
    (t.input ?? 0) +
    (t.output ?? 0) +
    (t.reasoning ?? 0) +
    ((t.cache?.read ?? 0) + (t.cache?.write ?? 0))
  );
}

/** Pure token math for the modal — exported for characterization tests. */
export function getSessionContextMetrics(
  messages: MessageWithParts[],
  providers: ProviderListResponse | undefined,
  pricingLookup: ModelPricingLookup,
): Metrics {
  const totalCost = getSessionCost(messages, pricingLookup);
  const rawMessages = messages.map((m) => m.info);

  // Find last assistant with tokens
  let last: AssistantMessage | undefined;
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (msg.role !== 'assistant') continue;
    if (tokenTotal(msg) <= 0) continue;
    last = msg;
    break;
  }
  if (!last) return { totalCost, context: undefined };

  const provider = providers?.all?.find((p) => p.id === last.providerID);
  const model = provider?.models?.[last.modelID];
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
  const upstreamProviderId =
    last.providerID === 'kortix' && modelProvider ? modelProvider : last.providerID;

  return {
    totalCost,
    context: {
      message: last,
      providerLabel:
        PROVIDER_LABELS[upstreamProviderId] ?? provider?.name ?? last.providerID,
      modelLabel: model?.name ?? last.modelID,
      limit,
      input: last.tokens?.input ?? 0,
      output: last.tokens?.output ?? 0,
      reasoning: last.tokens?.reasoning ?? 0,
      cacheRead: last.tokens?.cache?.read ?? 0,
      cacheWrite: last.tokens?.cache?.write ?? 0,
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  };
}
