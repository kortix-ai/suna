import type { Agent } from '@earendil-works/pi-agent-core';

export function applyGenerationSettings(
  agent: Agent,
  settings: { temperature?: number; top_p?: number } | undefined,
): void {
  if (!settings) return;
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
