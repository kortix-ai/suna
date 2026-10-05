import type { FlatModel } from './session-chat-input';

const FREE_TOKEN = /(^|[\s/_-])free($|[\s/_-])/i;

export function shouldShowFreeTag(
  model: Pick<FlatModel, 'free' | 'modelID' | 'modelName'>,
): boolean {
  if (model.free === true) return true;
  return FREE_TOKEN.test(model.modelName) || FREE_TOKEN.test(model.modelID);
}

/**
 * The gateway's subscription route: a model billed to a connected ChatGPT
 * Plus/Pro account rather than metered per token. Wire ids are `codex/<model>`
 * and the explicit provider field is `codex`; both are checked because a stale
 * baked catalog can predate the field (same fallback `pickerGroupId` uses).
 */
export function isSubscriptionModel(
  model: Pick<FlatModel, 'modelID'> & { provider?: string | null },
): boolean {
  return model.provider === 'codex' || model.modelID.startsWith('codex/');
}

/**
 * What the picker prints for a model.
 *
 * The gateway appends " (ChatGPT)" to every subscription model's name
 * (`picker-catalog.ts`, `catalog-models.ts`) so surfaces with no grouping —
 * the CLI, `/v1/models` — can still tell `gpt-6-astra` from
 * `codex/gpt-6-astra`. The picker HAS grouping: the rows already sit under a
 * "ChatGPT subscription" heading, so the suffix repeated the heading on every
 * row and pushed the real name off the same column as its managed twin.
 *
 * Display only. Search, aria labels and every stored id keep the full name, so
 * typing "chatgpt" still finds these rows.
 */
export function pickerModelName(
  model: Pick<FlatModel, 'modelID' | 'modelName'> & { provider?: string | null },
): string {
  if (!isSubscriptionModel(model)) return model.modelName;
  return model.modelName.replace(/\s*\(ChatGPT\)\s*$/, '').trim() || model.modelName;
}
