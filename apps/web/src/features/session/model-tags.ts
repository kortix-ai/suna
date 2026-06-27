import type { FlatModel } from './session-chat-input';

const FREE_TOKEN = /(^|[\s/_-])free($|[\s/_-])/i;

export function shouldShowFreeTag(model: Pick<FlatModel, 'free' | 'modelID' | 'modelName'>): boolean {
  if (model.free === true) return true;
  return FREE_TOKEN.test(model.modelName) || FREE_TOKEN.test(model.modelID);
}

// Map a (provider, model) pair from the provider modal into the visibility
// store key the session picker uses, so a show/hide in one surface matches the
// other. opencode-native: managed models keep the `kortix` provider id, BYOK
// providers are native (their own id), and ChatGPT is served under the managed
// `kortix` provider namespaced as `codex/<id>` — so a `codex` row maps back to
// that namespaced key.
export function modelVisibilityKeyForProviderModel(
  providerID: string,
  modelID: string,
): { providerID: string; modelID: string } {
  if (providerID === 'codex') return { providerID: 'kortix', modelID: `codex/${modelID}` };
  return { providerID, modelID };
}
