import type { StatusTone } from '@/components/ui/status';
import type { MessageWithParts } from '@kortix/sdk/react';
import type { FlatModel } from '../model-flatten';

export interface ContextBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache: number;
  total: number;
}

const EMPTY_BREAKDOWN: ContextBreakdown = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: 0,
  total: 0,
};

export function getLastAssistantTokenBreakdown(
  messages: MessageWithParts[] | undefined,
): ContextBreakdown {
  if (!messages) return EMPTY_BREAKDOWN;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== 'assistant') continue;
    const t = msg.info.tokens;
    if (!t) continue;
    const input = t.input ?? 0;
    const output = t.output ?? 0;
    const reasoning = t.reasoning ?? 0;
    const cache = (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    const total = input + output + reasoning + cache;
    if (total > 0) return { input, output, reasoning, cache, total };
  }
  return EMPTY_BREAKDOWN;
}

export function getLastAssistantTokenTotal(messages: MessageWithParts[] | undefined): number {
  return getLastAssistantTokenBreakdown(messages).total;
}

export const CONTEXT_WARNING_RATIO = 0.7;
export const CONTEXT_DANGER_RATIO = 0.85;

export function contextTone(ratio: number): StatusTone {
  if (ratio >= CONTEXT_DANGER_RATIO) return 'destructive';
  if (ratio >= CONTEXT_WARNING_RATIO) return 'warning';
  return 'info';
}

export function getContextLimit(
  models: FlatModel[] | undefined,
  selectedModel: { providerID: string; modelID: string } | null | undefined,
): number {
  if (selectedModel && models) {
    const model = models.find(
      (m) => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID,
    );
    if (model?.contextWindow && model.contextWindow > 0) return model.contextWindow;
  }
  return 200000;
}

export function getSelectedModelName(
  models: FlatModel[] | undefined,
  selectedModel: { providerID: string; modelID: string } | null | undefined,
): string | null {
  if (!selectedModel || !models) return null;
  const model = models.find(
    (m) => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID,
  );
  const name = model?.modelName?.trim();
  return name ? name : null;
}

export function formatContextCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    if (k >= 100) return `${Math.round(k)}k`;
    return `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = tokens / 1_000_000;
  if (Number.isInteger(m)) return `${m}m`;
  return `${m.toFixed(1).replace(/\.0$/, '')}m`;
}

export interface ContextReading {
  percent: number;
  tone: StatusTone;
}

export interface ContextUsage extends ContextReading {
  breakdown: ContextBreakdown;
  limit: number;
  ratio: number;
  modelName: string | null;
}

export function getContextUsage(
  messages: MessageWithParts[] | undefined,
  models?: FlatModel[],
  selectedModel?: { providerID: string; modelID: string } | null,
): ContextUsage {
  const breakdown = getLastAssistantTokenBreakdown(messages);
  const limit = getContextLimit(models, selectedModel);
  const ratio = breakdown.total > 0 ? Math.min(breakdown.total / limit, 1) : 0;
  return {
    percent: Math.round(ratio * 100),
    tone: contextTone(ratio),
    breakdown,
    limit,
    ratio,
    modelName: getSelectedModelName(models, selectedModel),
  };
}

export function getContextReading(
  messages: MessageWithParts[] | undefined,
  models?: FlatModel[],
  selectedModel?: { providerID: string; modelID: string } | null,
): ContextReading {
  const { percent, tone } = getContextUsage(messages, models, selectedModel);
  return { percent, tone };
}
