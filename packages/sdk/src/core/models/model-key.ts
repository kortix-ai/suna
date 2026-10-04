/** A model's identity in the composer: provider + model id. */
export type ModelKey = {
  providerID: string;
  modelID: string;
  /**
   * The REAL upstream provider a `kortix`-gateway model resolves against
   * ('anthropic', 'openai', 'codex', 'kortix', ...) — see `FlatModel.provider`
   * (model-flatten.ts). When present, `subProviderOf` uses it directly instead
   * of parsing `modelID`, so connection-gating never depends on the wire id
   * happening to be namespaced `<provider>/<model>`. Optional so every
   * existing caller (which only ever had `providerID`/`modelID`) keeps
   * compiling unchanged.
   */
  provider?: string;
};

// ── Gateway wire-model ⟷ ModelKey conversion ───────────────────────────────
// The LLM gateway identifies a model by its "wire model" — what opencode sends
// as `body.model`. Under the kortix gateway provider that is just the modelID
// (a bare managed id like 'glm-5.3-flash', or a BYOK 'provider/model'). A direct
// provider model uses 'provider/model'.
export function modelKeyToWire(model: ModelKey): string {
  if (model.providerID === 'kortix' || model.providerID === 'opencode') return model.modelID;
  return `${model.providerID}/${model.modelID}`;
}

export function wireToModelKey(wire: string): ModelKey {
  // Managed (bare) and BYOK ('provider/model') both live under the kortix
  // provider in the picker namespace, so the modelID carries the full wire id.
  return { providerID: 'kortix', modelID: wire };
}

/**
 * A STORED model ref (a session pin, a channel binding, a trigger, an agent's
 * `model`) as the picker's `ModelKey`, in the project's gateway mode.
 *
 *  • Gateway on — the ref is a gateway wire id; `kortix/<wire>` (the form a
 *    session pin keeps) and `<wire>` name the same model under `kortix`.
 *  • Gateway off — the ref is the native `provider/model`, split on the FIRST
 *    slash (`openrouter/z-ai/glm-4.7-flash`). A ref with no provider falls
 *    back to the gateway shape, which fails the catalog lookup (renders unset).
 */
export function modelRefToKey(ref: string, gatewayEnabled: boolean): ModelKey {
  const wire = ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
  if (!gatewayEnabled) {
    const slash = wire.indexOf('/');
    if (slash > 0 && slash < wire.length - 1) {
      return { providerID: wire.slice(0, slash), modelID: wire.slice(slash + 1) };
    }
  }
  return wireToModelKey(wire);
}
