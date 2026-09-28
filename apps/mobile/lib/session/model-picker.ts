/**
 * model-picker — the composer's model sheet rows: which provider group, which
 * order, and which rows the empty-search view shows. The list itself is
 * `@kortix/sdk`'s (`useComposerModels`: `pickerProviderList` →
 * `flattenModels`), the same list web's session model selector renders.
 *
 * Groups are the REAL upstream provider (`provider`, else the wire id prefix),
 * never the raw provider name: under the gateway that name is always "Kortix".
 * The groups, labels, and row names are web's `model-grouping.ts` and
 * `model-tags.ts`, which live in `apps/web`, not the SDK.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */
import {
  createModelVisibility,
  flattenModels,
  modelInDefaultView,
  pickerProviderList,
  type FlatModel,
  type PickerProviderListInput,
} from '@kortix/sdk';
import type { PickerOption } from './composer-config';

/** The model fields the groups read. The SDK's `FlatModel` satisfies it. */
export interface PickerModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  /** The upstream provider that serves a gateway model ('anthropic', 'codex', …). */
  provider?: string;
  variants?: Record<string, Record<string, unknown>>;
}

const GATEWAY_PROVIDER_ID = 'kortix';

/**
 * The composer's model list for one set of sources (`useComposerModels`):
 * `@kortix/sdk` builds it, `pickerProviderList` → `flattenModels`, in the
 * provider mode web's `modelProviderMode` reads off the same list.
 */
export function composerModelList(input: PickerProviderListInput): FlatModel[] {
  return flattenModels(pickerProviderList(input), {
    providerMode: input.gatewayEnabled ? 'gateway' : 'native',
  });
}

/** Models the project offers (`enabled !== false`): zero means "Connect model" (KRTX-251). */
export function offeredModelCount(models: FlatModel[]): number {
  return models.filter((m) => m.enabled !== false).length;
}

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

/**
 * The picks project home sends with the first message (`pending_prompt` on
 * session create, web's channel). Null when there is no level to carry: the
 * model alone already travels as `opencode_model`. A level the active model
 * does not offer (picked for another model) is not sent.
 */
export function firstPromptPicks(
  model: { providerID: string; modelID: string } | null,
  variant: string | null,
  levels: string[],
): { model: { providerID: string; modelID: string }; variant: string } | null {
  if (!model || !variant || !levels.includes(variant)) return null;
  return { model: { providerID: model.providerID, modelID: model.modelID }, variant };
}

/** A sheet row's id. A model id can contain "/", so callers look the key up, never split it. */
export function modelOptionKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

function groupRank(groupID: string): number {
  const index = PICKER_PROVIDER_ORDER.indexOf(groupID);
  return index === -1 ? PICKER_PROVIDER_ORDER.length : index;
}

/**
 * Sheet rows in display order: groups by `PICKER_PROVIDER_ORDER`, unknown
 * providers after them by title; rows by name inside a group.
 *
 * Web's model selector rules: models the project turned off (`enabled:
 * false`) are not rows; a row the empty-search view hides
 * (`modelInDefaultView` over `createModelVisibility`: newest per family for
 * native providers, every gateway model) is `searchOnly`. `selected` always
 * shows. Mobile has no "Manage models" pins, so none are passed.
 */
export function modelPickerOptions(
  models: FlatModel[],
  selected: { providerID: string; modelID: string } | null,
): PickerOption[] {
  const isStoreVisible = createModelVisibility({ catalogModels: models });
  return models
    .filter((model) => model.enabled !== false)
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
      key: modelOptionKey(model),
      label,
      group,
      keywords: `${model.modelName} ${model.modelID}`,
      searchOnly: !modelInDefaultView(model, { search: '', isStoreVisible, selected }),
    }));
}
