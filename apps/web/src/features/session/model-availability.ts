import type { ModelKey } from '@kortix/sdk/react';

export const NO_MODEL_AVAILABLE_MESSAGE = 'No models available for this session yet.';
export const NO_MODEL_AVAILABLE_ACTION_MESSAGE =
  'Connect a model via provider first or upgrade your Kortix subscription.';

export function resolveAvailableSelectedModel(
  selectedModel: ModelKey | null | undefined,
  isSelectableModel: (model: ModelKey) => boolean,
): ModelKey | null {
  if (!selectedModel) return null;
  return isSelectableModel(selectedModel) ? selectedModel : null;
}

/**
 * The name of the selected model when it cannot read an attached image, else null.
 *
 * Refuses only on an explicit `vision: false`. A model without capability data
 * (a custom provider) is never refused on a guess. Only images are checked: every
 * other file lands in the sandbox, where the agent reads it with tools.
 */
export function modelRejectingAttachedImages({
  files,
  models,
  selectedModel,
}: {
  files: ReadonlyArray<{ isImage: boolean }>;
  models: ReadonlyArray<{
    providerID: string;
    modelID: string;
    modelName: string;
    capabilities?: { vision?: boolean };
  }>;
  selectedModel: ModelKey | null | undefined;
}): string | null {
  if (!selectedModel || !files.some((file) => file.isImage)) return null;
  const model = models.find(
    (candidate) =>
      candidate.providerID === selectedModel.providerID &&
      candidate.modelID === selectedModel.modelID,
  );
  return model?.capabilities?.vision === false ? model.modelName : null;
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
