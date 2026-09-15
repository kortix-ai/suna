import type { ModelKey } from './use-model-store';

export function resolveSessionDisplayModel(
  runtime: 'pi-worker' | 'opencode' | undefined,
  compiledModel: string | undefined,
  selectedModel: ModelKey | undefined,
): ModelKey | undefined {
  if (runtime !== 'pi-worker') return selectedModel;
  const separator = compiledModel?.indexOf('/') ?? -1;
  if (!compiledModel || separator <= 0 || separator === compiledModel.length - 1) return undefined;
  return {
    providerID: compiledModel.slice(0, separator),
    modelID: compiledModel.slice(separator + 1),
  };
}
