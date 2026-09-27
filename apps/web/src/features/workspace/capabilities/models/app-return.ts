/**
 * The mobile app's "connect a model provider" hand-off. The `return_to`
 * scheme check lives in `../shared/app-return-url.ts`.
 */

/** The mobile model-picker's own rule (`catalogPickerModels`): enabled models,
 *  never the `auto` router entry. Both sides must count the same way, or the
 *  page returns the user to an app that still shows "no models". */
const AUTO_MODEL_IDS = new Set(['auto', 'kortix/auto']);

export function usableModelCount(
  models: ReadonlyArray<{ modelID: string; enabled?: boolean }>,
): number {
  return models.filter((m) => m.enabled !== false && !AUTO_MODEL_IDS.has(m.modelID)).length;
}
