// THE DEFAULT PROVIDER SET — the three APIs that cover almost every model
// anyone actually points an agent at, and nothing else.
//
// Measured against the full catalogue: 2051 KB and ~116 ms first-cell cold
// start, versus 2819 KB and ~127 ms for all 39 providers. That is 768 KB and
// 11 ms — small enough that `all` is the default and this set is the opt-out,
// not the other way round. Pick it when bundle size actually matters to you.
//
// Note what this does NOT cost you: any OpenAI-compatible endpoint — OpenRouter,
// Groq, DeepSeek, Together, Fireworks, Cerebras, xAI, Azure, a local gateway —
// already works here by setting `base_url`. The slim set is three APIs, not
// three vendors.
export const PROVIDER_APIS = {
  openai: { api: "openai-completions", baseUrl: "https://api.openai.com/v1", load: () => import("@earendil-works/pi-ai/api/openai-completions") },
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", load: () => import("@earendil-works/pi-ai/api/anthropic-messages") },
  google: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com", load: () => import("@earendil-works/pi-ai/api/google-generative-ai") },
};

export const SET_NAME = "slim";

export function listProviders() { return Object.keys(PROVIDER_APIS); }

export function lookupModel({ provider, modelId, baseUrl }) {
  const p = PROVIDER_APIS[provider];
  if (!p) {
    throw new Error(
      `provider '${provider}' is not in the slim set (${listProviders().join(", ")}). ` +
      `Either set model.providers="all" in agent.config.json, or — if it speaks the ` +
      `OpenAI API — use provider "openai" with model.base_url pointing at it.`,
    );
  }
  return {
    id: modelId, name: modelId, api: p.api, provider,
    baseUrl: baseUrl || p.baseUrl, reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function streamFor(provider) {
  const p = PROVIDER_APIS[provider];
  if (!p) throw new Error(`provider '${provider}' is not in the slim set`);
  let streamSimple;
  // Lazy, so a cell running the scripted model never initialises a provider.
  return async (model, context, options) => {
    if (!streamSimple) ({ streamSimple } = await p.load());
    return streamSimple(model, context, options);
  };
}
