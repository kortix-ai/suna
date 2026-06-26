import type { FlatModel } from './session-chat-input';

const FREE_TOKEN = /(^|[\s/_-])free($|[\s/_-])/i;

export function shouldShowFreeTag(model: Pick<FlatModel, 'free' | 'modelID' | 'modelName'>): boolean {
  if (model.free === true) return true;
  return FREE_TOKEN.test(model.modelName) || FREE_TOKEN.test(model.modelID);
}

export function modelVisibilityKeyForProviderModel(
  providerID: string,
  modelID: string,
): { providerID: string; modelID: string } {
  // The gateway is the only LLM path: every provider's models live under the
  // single `kortix` namespace (BYOK models keep a `<provider>/` prefix).
  return {
    providerID: 'kortix',
    modelID: providerID === 'kortix' ? modelID : `${providerID}/${modelID}`,
  };
}
