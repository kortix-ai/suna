/**
 * Grouping and labelling rules for the model picker. Pure.
 *
 * The gateway serves its whole catalog through ONE synthetic `kortix` opencode
 * provider, so `FlatModel.providerName` always reads "Kortix" and cannot group
 * anything. The real provider rides on `FlatModel.provider`; a stale baked
 * catalog that predates that field is recovered by splitting the namespaced
 * `modelID` (`anthropic/claude-sonnet-5` → `anthropic`). Same rule apps/web's
 * `model-grouping.ts` applies — reimplemented here rather than imported,
 * because `@kortix/tui` must not reach into another app's source, and
 * `@kortix/llm-catalog` (where web's `PROVIDER_LABELS` lives) is not one of
 * this package's dependencies.
 */

import type { FlatModel } from '@kortix/sdk/react';

/** Display names for the provider ids the gateway serves today. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'Codex',
  google: 'Google',
  'google-vertex': 'Google Vertex',
  bedrock: 'Bedrock',
  'amazon-bedrock': 'Bedrock',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot',
  openrouter: 'OpenRouter',
  zhipuai: 'Zhipu',
  kortix: 'Kortix',
  opencode: 'OpenCode',
};

/** The provider a model is filed under. */
export function modelGroupId(model: FlatModel): string {
  if (model.providerID !== 'kortix') return model.providerID;
  if (model.provider) return model.provider;
  const slash = model.modelID.indexOf('/');
  return slash === -1 ? model.providerID : model.modelID.slice(0, slash);
}

/** The group's heading. Never `FlatModel.providerName` — see the file note. */
export function modelGroupLabel(groupId: string): string {
  const known = PROVIDER_LABELS[groupId];
  if (known) return known;
  if (!groupId) return 'Other';
  return groupId.charAt(0).toUpperCase() + groupId.slice(1);
}

export interface ModelGroup {
  id: string;
  label: string;
  models: FlatModel[];
}

/**
 * `models`, grouped by real provider and sorted: groups alphabetically by
 * label, models alphabetically by name inside a group. Offered models come
 * before unavailable ones within a group, so what the user can pick is on top.
 */
export function groupModels(models: readonly FlatModel[]): ModelGroup[] {
  const byGroup = new Map<string, FlatModel[]>();
  for (const model of models) {
    const id = modelGroupId(model);
    const bucket = byGroup.get(id);
    if (bucket) bucket.push(model);
    else byGroup.set(id, [model]);
  }
  const groups: ModelGroup[] = [];
  for (const [id, bucket] of byGroup) {
    bucket.sort((a, b) => {
      const availability = Number(isUnavailable(b)) - Number(isUnavailable(a));
      if (availability !== 0) return -availability;
      return a.modelName.localeCompare(b.modelName);
    });
    groups.push({ id, label: modelGroupLabel(id), models: bucket });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

/**
 * The project does not offer this model.
 *
 * `enabled` is server-owned per-project enablement from `/model-picker`. Only
 * an explicit `false` means off: a catalog that does not carry the field leaves
 * it `undefined`, which means "not applicable", never "unavailable".
 */
export function isUnavailable(model: FlatModel): boolean {
  return model.enabled === false;
}

/** `kortix:claude-sonnet-5` — the picker row id and the selection identity. */
export function modelRowId(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}:${model.modelID}`;
}
