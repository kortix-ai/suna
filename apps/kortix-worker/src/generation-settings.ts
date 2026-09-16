import type { Agent } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels, type ModelThinkingLevel } from '@earendil-works/pi-ai';

export function applyReasoningVariant(agent: Agent, variant: string): void {
  const level = variant === 'none' ? 'off' : variant;
  if (!agent.state.model || !getSupportedThinkingLevels(agent.state.model).includes(level as ModelThinkingLevel)) {
    throw new Error(`reasoning variant "${variant}" is not supported by the selected model`);
  }
  agent.state.thinkingLevel = level as ModelThinkingLevel;
}

export function supportedReasoningVariants(agent: Agent): string[] {
  if (!agent.state.model?.reasoning) return [];
  return getSupportedThinkingLevels(agent.state.model).map(level => level === 'off' ? 'none' : level);
}

export function applyGenerationSettings(
  agent: Agent,
  settings: { temperature?: number; top_p?: number; variant?: string } | undefined,
): void {
  if (!settings) return;
  if (settings.variant) applyReasoningVariant(agent, settings.variant);
  const { temperature, top_p: topP } = settings;
  for (const [field, value] of [
    ['temperature', temperature],
    ['top_p', topP],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`compiled agent ${field} must be a finite number`);
    }
  }
  if (temperature === undefined && topP === undefined) return;

  const stream = agent.streamFunction;
  agent.streamFunction = (model, context, options) => {
    const configured = {
      ...options,
      ...(temperature === undefined ? {} : { temperature }),
    };
    if (topP !== undefined) {
      if (model.api === 'anthropic-messages') {
        configured.onPayload = async (payload, selectedModel) => {
          const transformed = (await options?.onPayload?.(payload, selectedModel)) ?? payload;
          return { ...(transformed as Record<string, unknown>), top_p: topP };
        };
      } else {
        configured.samplingParams = { ...options?.samplingParams, top_p: topP };
      }
    }
    return stream(model, context, configured);
  };
}
