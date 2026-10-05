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

/**
 * Whether this prompt must be refused because the project offers no model.
 *
 * `modelsLoading` / `entitlementsPending` are the "the answer is not in yet"
 * inputs, and while either is true this refuses NOTHING. An absent
 * `selectedModel` means two different things and only one of them is a
 * refusal: "the catalog says none is offered" (refuse) versus "the catalog has
 * not arrived" (wait). Reading the second as the first is what lost prompts on
 * a slow API — see the regression test in `model-availability.test.ts` and
 * `27-desktop-parity.spec.ts`. The sibling `noModelsConnected` tray in
 * `composer/composer.tsx` already gated itself on exactly these two flags;
 * this send gate did not, so the tray stayed silent while the send was
 * refused with "No models available for this session yet."
 */
export function isModelRequiredButUnavailable({
  modelRequired,
  selectedModel,
  lockForQuestion,
  modelsLoading = false,
  entitlementsPending = false,
}: {
  modelRequired: boolean;
  selectedModel: ModelKey | null | undefined;
  lockForQuestion: boolean;
  /** The model catalog query is still in flight. */
  modelsLoading?: boolean;
  /** An input the served catalog depends on is still resolving. */
  entitlementsPending?: boolean;
}): boolean {
  if (modelsLoading || entitlementsPending) return false;
  return modelRequired && !lockForQuestion && !selectedModel;
}
