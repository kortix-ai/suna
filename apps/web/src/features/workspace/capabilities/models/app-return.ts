/**
 * The mobile app's "connect a model provider" hand-off.
 *
 * The app opens `/projects/:id/customize/models?return_to=kortix://…` in an
 * in-app auth session. Once the project has a usable model, the page sends the
 * browser to `return_to`, and the auth session closes itself on that URL.
 *
 * Only the `kortix:` scheme is accepted: `return_to` is user-controlled query
 * input, and any other value must never become a redirect target.
 */
const MAX_RETURN_URL_LENGTH = 256;

export function parseAppReturnUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_RETURN_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'kortix:') return null;
  return raw;
}

/** The mobile model-picker's own rule (`catalogPickerModels`): enabled models,
 *  never the `auto` router entry. Both sides must count the same way, or the
 *  page returns the user to an app that still shows "no models". */
const AUTO_MODEL_IDS = new Set(['auto', 'kortix/auto']);

export function usableModelCount(
  models: ReadonlyArray<{ modelID: string; enabled?: boolean }>,
): number {
  return models.filter((m) => m.enabled !== false && !AUTO_MODEL_IDS.has(m.modelID)).length;
}
