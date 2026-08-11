import type { ModelKey } from '@kortix/sdk/react';

export const NO_MODEL_AVAILABLE_MESSAGE = 'No models available for this session yet.';
export const NO_MODEL_AVAILABLE_ACTION_MESSAGE =
  'Connect a model via provider first or upgrade your dosco subscription.';

export function resolveAvailableSelectedModel(
  selectedModel: ModelKey | null | undefined,
  isSelectableModel: (model: ModelKey) => boolean,
): ModelKey | null {
  if (!selectedModel) return null;
  return isSelectableModel(selectedModel) ? selectedModel : null;
}

export function isModelRequiredButUnavailable({
  modelRequired,
  selectedModel,
  lockForQuestion,
}: {
  modelRequired: boolean;
  selectedModel: ModelKey | null | undefined;
  lockForQuestion: boolean;
}): boolean {
  return modelRequired && !lockForQuestion && !selectedModel;
}
