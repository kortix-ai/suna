/**
 * composer-model — the model pill on the project home composer.
 *
 * The home has no sandbox, so the choices come from the project's gateway
 * catalog (`GET /projects/:id/model-picker`, the same source web's home uses).
 * The pick is sent as `opencode_model` when the session is created. A project
 * without the LLM gateway has no catalog, so the pill is hidden.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */
import type { ProjectLlmCatalogResponse } from '../projects/projects-client';

export interface ComposerModelOption {
  /** Gateway wire id — the `opencode_model` value. */
  modelID: string;
  modelName: string;
}

/** Models the project offers, sorted by name. `enabled: false` is hidden. */
export function composerModelOptions(
  models: ProjectLlmCatalogResponse['models'] | undefined,
): ComposerModelOption[] {
  return Object.entries(models ?? {})
    .filter(([, model]) => model.enabled !== false)
    .map(([modelID, model]) => ({ modelID, modelName: model.name || modelID }))
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}

/** The model a send runs on: the pick, else the project default. */
export function effectiveComposerModel(
  selected: string | null,
  defaultModel: string | undefined,
): string | null {
  return selected ?? defaultModel ?? null;
}

/**
 * State after picking a row. Picking the project default clears the pick, so
 * the session keeps following the project default instead of pinning it.
 */
export function selectComposerModel(modelID: string, defaultModel: string | undefined): string | null {
  return modelID === defaultModel ? null : modelID;
}

/** Pill text. Null hides the pill: there is nothing to choose from. */
export function composerModelLabel(
  options: ComposerModelOption[],
  selected: string | null,
  defaultModel: string | undefined,
): string | null {
  if (options.length === 0) return null;
  const active = effectiveComposerModel(selected, defaultModel);
  return options.find((o) => o.modelID === active)?.modelName ?? 'Default';
}
