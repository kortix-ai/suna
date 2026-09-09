// THE DEFAULT PROVIDER SET — the three APIs that cover almost every model
// anyone actually points an agent at, and nothing else.
//
// Re-measured 2026-09-09: 4074 KB against 4842 KB for all 39 providers. The
// 768 KB gap is real; the absolute numbers that used to be here (2051 / 2819)
// were two megabytes out of date, and so was the cold-start pair that went
// with them — a 38% cut measured no faster at all. See build.mjs.
//
// `./test/all.sh` had only ever run against `all`, and this set could not run
// a scripted turn at all — see the eager import below for what was wrong and
// how it is now pinned.
//
// Note what this does NOT cost you: any OpenAI-compatible endpoint — OpenRouter,
// Groq, DeepSeek, Together, Fireworks, Cerebras, xAI, Azure, a local gateway —
// already works here by setting `base_url`. The slim set is three APIs, not
// three vendors.
// ONE API IMPORTED EAGERLY, and the eagerness is load-bearing.
//
// `createAssistantMessageEventStream()` comes from the pi-ai root, but the
// class it builds is ASSIGNED inside esbuild's lazy initialiser for the
// event-stream module, and the only callers of that initialiser are API
// modules. Every entry below defers its module behind `load()`, so on a slim
// bundle nothing had initialised it by the time the SCRIPTED model — which
// needs no provider at all — asked for a stream.
//
// Measured 2026-09-09: a slim bundle answered a scripted prompt with 200 and
// wrote NO assistant message, and its cell suite stopped at 21 of 25. The full
// set only ever worked because one of its 39 providers got there first, which
// is luck, not design. test/build-and-model.mjs runs a scripted turn on each
// set now, so this cannot go quiet again.
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";

export const PROVIDER_APIS = {
  openai: { api: "openai-completions", baseUrl: "https://api.openai.com/v1", load: async () => openaiCompletions },
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
  // EVERY FIELD THE STREAM READS, not just the ones that identify a model. pi's
  // stream asks `model.input.includes("image")` before it sends anything, so a
  // record without `input` dies with "Cannot read properties of undefined
  // (reading 'includes')" — thrown before any network call and delivered as an
  // `error` EVENT, which the agent stores as an assistant message with empty
  // content while the turn reports success. Every model in the slim set is
  // synthetic, so this record is the only one there is. See providers.all.js.
  return {
    id: modelId, name: modelId, api: p.api, provider,
    baseUrl: baseUrl || p.baseUrl, reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    compat: { supportsStrictMode: false },
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
