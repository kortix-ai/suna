/**
 * composer-model — the model pick on the project home composer.
 *
 * The home lists the project's models (`useComposerModels`, the list web
 * shows) and resolves the default through `@kortix/sdk`
 * (`resolveComposerModel`). A pick is sent as the session's `model` when the
 * session is created.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */

/**
 * State after picking a row (`modelOptionKey`). Picking the default clears
 * the pick, so the session keeps following the project default instead of
 * pinning it.
 */
export function selectComposerModel(key: string, defaultKey: string | null): string | null {
  return key === defaultKey ? null : key;
}

/**
 * The session `model` value of a pick: the bare gateway wire id (the API
 * stores `kortix/<wire>`).
 */
export function sessionModelRef(model: { providerID: string; modelID: string }): string {
  return model.modelID;
}

/**
 * The project offers no model, so a send must not start a session or post a
 * message (KRTX-251; web's `isModelRequiredButUnavailable`). True only once
 * the gateway list has loaded and is empty. While it loads nothing is blocked.
 */
export function isModelUnavailable(i: { loading: boolean; modelCount: number }): boolean {
  return !i.loading && i.modelCount === 0;
}
