import type { ModelKey } from '@/hooks/opencode/use-opencode-local';

export const NO_MODEL_AVAILABLE_MESSAGE = 'No models available for this session yet.';
export const NO_MODEL_AVAILABLE_ACTION_MESSAGE =
  'Connect a model via provider first or upgrade your Kortix subscription.';

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
