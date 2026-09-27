/**
 * model-picker — which models the composer's model sheet lists, in which
 * groups and order. The rules are web's session model selector
 * (`apps/web/src/features/session/model-selector.tsx`, `model-grouping.ts`,
 * `model-tags.ts`), so a project shows the same list on web, on the mobile
 * project home, and in a mobile thread.
 *
 * One source per project, the same on home and in a thread:
 * - LLM gateway on: the project's `/model-picker` catalog. Every model is served
 *   through the one `kortix` provider; `enabled !== false` is the server's
 *   answer to "does this project offer it".
 * - LLM gateway off (no catalog): the sandbox's own providers, without `kortix`.
 *
 * Groups are the REAL upstream provider (`provider`, else the wire id prefix),
 * never the raw provider name: under the gateway that name is always "Kortix".
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */
import type { PickerOption } from './composer-config';

/** The model fields the picker reads. Mobile's `FlatModel` satisfies it. */
export interface PickerModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  /** The upstream provider that serves a gateway model ('anthropic', 'codex', …). */
  provider?: string;
  variants?: Record<string, Record<string, unknown>>;
}

/** The `/model-picker` fields read here (`GatewayCatalogModel` in @kortix/sdk). */
export interface PickerCatalogModel {
  name?: string;
  provider?: string;
  enabled?: boolean;
  reasoning?: boolean;
  variants?: Record<string, Record<string, unknown>>;
  /** models.dev's tunable reasoning knobs. The catalog's thinking levels come from here. */
  reasoning_options?: Array<{ type: string; values?: Array<string | null>; min?: number; max?: number }>;
  limit?: { context?: number };
  family?: string;
  release_date?: string;
}
export type PickerCatalog = Record<string, PickerCatalogModel>;

const GATEWAY_PROVIDER_ID = 'kortix';
/** The gateway's routing alias. It is not a model a user picks. */
const AUTO_MODEL_IDS = new Set(['auto', 'kortix/auto']);

/**
 * Group order, then unknown providers by label. A copy of
 * `MODEL_SELECTOR_PROVIDER_IDS` in @kortix/llm-catalog, which Metro cannot
 * resolve from this app. `model-picker.test.ts` fails when the copy drifts.
 */
export const PICKER_PROVIDER_ORDER = [
  'kortix',
  'opencode',
  'anthropic',
  'openai',
  'github-copilot',
  'google',
  'openrouter',
  'vercel',
];

/** Group titles. A copy of the @kortix/llm-catalog `PROVIDER_LABELS` entries a picker can meet; pinned by the same test. */
export const PICKER_PROVIDER_LABELS: Record<string, string> = {
  kortix: 'Kortix',
  opencode: 'OpenCode Zen',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'ChatGPT subscription',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  'google-vertex': 'Google Vertex',
  'google-vertex-anthropic': 'Vertex Anthropic',
  openrouter: 'OpenRouter',
  vercel: 'Vercel',
  xai: 'xAI',
  moonshotai: 'Moonshot',
  'moonshotai-cn': 'Moonshot',
  'amazon-bedrock': 'Amazon Bedrock',
  bedrock: 'Amazon Bedrock',
  azure: 'Azure',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  cohere: 'Cohere',
  cerebras: 'Cerebras',
  togetherai: 'Together AI',
  fireworks: 'Fireworks',
  deepinfra: 'DeepInfra',
  nvidia: 'NVIDIA',
  perplexity: 'Perplexity',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  minimax: 'MiniMax',
  zhipuai: 'ZhipuAI',
};

/** The provider a model belongs to in the picker. Web `pickerGroupId`. */
export function pickerGroupId(model: PickerModel): string {
  if (model.providerID !== GATEWAY_PROVIDER_ID) return model.providerID;
  if (model.provider) return model.provider;
  // An older catalog without `provider`: the wire id is `<provider>/<model>`.
  // Kortix-managed ids carry no "/", so they stay under `kortix`.
  const slash = model.modelID.indexOf('/');
  return slash === -1 ? model.providerID : model.modelID.slice(0, slash);
}

function pickerGroupLabel(groupID: string, model: PickerModel): string {
  return PICKER_PROVIDER_LABELS[groupID] ?? model.providerName;
}

function isSubscriptionModel(model: PickerModel): boolean {
  return model.provider === 'codex' || model.modelID.startsWith('codex/');
}

/**
 * The row text. ChatGPT-subscription models sit under the "ChatGPT
 * subscription" title, so their "(ChatGPT)" suffix is dropped. Display only:
 * search keeps the full name. Web `pickerModelName`.
 */
export function pickerModelName(model: PickerModel): string {
  if (!isSubscriptionModel(model)) return model.modelName;
  return model.modelName.replace(/\s*\(ChatGPT\)\s*$/, '').trim() || model.modelName;
}

/** A `budget_tokens` knob has no discrete values: the standard tiers stand in (@kortix/llm-catalog). */
const BUDGET_TOKENS_LEVELS = ['low', 'medium', 'high'];

/**
 * The thinking levels a catalog model offers. `/model-picker` sends an empty
 * `variants` map; the levels are in `reasoning_options`. Web's rule
 * (`projectLlmCatalogToProviderList` → `generationControlCapabilities`): an
 * explicit `variants` map wins, else the `effort` knob's published values,
 * else low/medium/high for a `budget_tokens` knob, else none (a `toggle` is
 * not a level). `model-picker.test.ts` pins this against the package.
 */
export function catalogThinkingLevels(entry: PickerCatalogModel): string[] {
  const explicit = Object.keys(entry.variants ?? {});
  if (explicit.length > 0) return explicit;
  const options = entry.reasoning_options ?? [];
  const effort = options.find((option) => option.type === 'effort');
  const values = (effort?.values ?? []).filter((value): value is string => typeof value === 'string');
  if (values.length > 0) return values;
  return options.some((option) => option.type === 'budget_tokens') ? [...BUDGET_TOKENS_LEVELS] : [];
}

function levelsAsVariants(levels: string[]): PickerModel['variants'] {
  return levels.length > 0 ? Object.fromEntries(levels.map((level) => [level, {}])) : undefined;
}

/**
 * The picks project home sends with the first message (`pending_prompt` on
 * session create, web's channel). Null when there is no level to carry: the
 * model alone already travels as `opencode_model`. A level the active model
 * does not offer (picked for another model) is not sent.
 */
export function firstPromptPicks(
  modelID: string | null,
  variant: string | null,
  levels: string[],
): { model: { providerID: string; modelID: string }; variant: string } | null {
  if (!modelID || !variant || !levels.includes(variant)) return null;
  return { model: { providerID: GATEWAY_PROVIDER_ID, modelID }, variant };
}

/** The models a gateway project offers, in catalog order. Empty without a catalog. */
export function catalogPickerModels(catalog: PickerCatalog | undefined): PickerModel[] {
  return Object.entries(catalog ?? {})
    .filter(([modelID, entry]) => entry.enabled !== false && !AUTO_MODEL_IDS.has(modelID))
    .map(([modelID, entry]) => ({
      providerID: GATEWAY_PROVIDER_ID,
      providerName: PICKER_PROVIDER_LABELS[GATEWAY_PROVIDER_ID],
      modelID,
      modelName: entry.name || modelID,
      provider: entry.provider,
      variants: levelsAsVariants(catalogThinkingLevels(entry)),
    }));
}

/**
 * The models a thread can run on.
 *
 * Gateway project: the catalog is the list (what web and project home show).
 * The sandbox's copy of a model wins when it exists, because it carries the
 * thinking levels the sandbox accepts; it gains the catalog's `provider`, and
 * the catalog's levels when it has none of its own.
 * No catalog: the sandbox's own providers; its `kortix` provider is dropped,
 * because the project does not route through the gateway.
 */
export function offeredSessionModels<T extends PickerModel>(
  sandboxModels: T[],
  catalog: PickerCatalog | undefined,
  fromCatalog: (model: PickerModel, entry: PickerCatalogModel) => T = (model) => model as T,
): T[] {
  if (!catalog) {
    return sandboxModels.filter(
      (m) => m.providerID !== GATEWAY_PROVIDER_ID && !AUTO_MODEL_IDS.has(m.modelID),
    );
  }
  const inSandbox = new Map(
    sandboxModels.filter((m) => m.providerID === GATEWAY_PROVIDER_ID).map((m) => [m.modelID, m]),
  );
  return catalogPickerModels(catalog).map((model) => {
    const live = inSandbox.get(model.modelID);
    if (!live) return fromCatalog(model, catalog[model.modelID]);
    // The sandbox's levels are what it accepts. A sandbox copy with none takes
    // the catalog's, so the thread offers the levels project home offered.
    const hasLevels = Object.keys(live.variants ?? {}).length > 0;
    return { ...live, provider: model.provider ?? live.provider, variants: hasLevels ? live.variants : model.variants };
  });
}

function groupRank(groupID: string): number {
  const index = PICKER_PROVIDER_ORDER.indexOf(groupID);
  return index === -1 ? PICKER_PROVIDER_ORDER.length : index;
}

/**
 * Sheet rows in display order: groups by `PICKER_PROVIDER_ORDER`, unknown
 * providers after them by title; rows by name inside a group. `keyOf` is the
 * row id the caller selects by.
 */
export function modelPickerOptions<T extends PickerModel>(models: T[], keyOf: (model: T) => string): PickerOption[] {
  return models
    .map((model) => {
      const groupID = pickerGroupId(model);
      return { model, groupID, group: pickerGroupLabel(groupID, model), label: pickerModelName(model) };
    })
    .sort(
      (a, b) =>
        groupRank(a.groupID) - groupRank(b.groupID) ||
        a.group.localeCompare(b.group) ||
        a.label.localeCompare(b.label),
    )
    .map(({ model, group, label }) => ({
      key: keyOf(model),
      label,
      group,
      keywords: `${model.modelName} ${model.modelID}`,
    }));
}
