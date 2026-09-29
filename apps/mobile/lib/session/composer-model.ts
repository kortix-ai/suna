/**
 * composer-model — the model pick on the project home composer.
 *
 * The home lists the project's models (`useComposerModels`, the list web
 * shows) and resolves the default through `@kortix/sdk`
 * (`resolveComposerModel`). A pick is sent as `opencode_model` when the
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
 * The `opencode_model` value of a pick. Gateway on: the bare gateway wire id
 * (the API stores `kortix/<wire>`). Gateway off: OpenCode's `provider/model`.
 */
export function opencodeModelRef(model: { providerID: string; modelID: string }): string {
  return model.providerID === 'kortix' ? model.modelID : `${model.providerID}/${model.modelID}`;
}

/**
 * The project offers no model, so a send must not start a session or post a
 * message (KRTX-251; web's `isModelRequiredButUnavailable`). True only once
 * the gateway list has loaded and is empty. While it loads nothing is blocked,
 * and a project without the gateway runs on its sandbox's own providers, so it
 * is never blocked here.
 */
export function isModelUnavailable(i: { hasCatalog: boolean; loading: boolean; modelCount: number }): boolean {
  return i.hasCatalog && !i.loading && i.modelCount === 0;
}
