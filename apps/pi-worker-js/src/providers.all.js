// THE FULL CATALOGUE — every provider pi ships that can run in a cell.
//
// The default. 2819 KB against slim's 2051 KB, and ~127 ms first-cell cold
// start against ~116 ms — 768 KB and 11 ms for 36 more providers, paid once per
// node. Each provider record carries its own `streamSimple`, so there is no
// per-provider code here either: the catalogue IS the support.
import { builtinProviders, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

// The one that cannot run in a cell: the AWS SDK does not bundle for a V8
// isolate (13 unresolved node imports). Named, rather than failing at runtime.
const UNSUPPORTED = {
  "amazon-bedrock":
    "amazon-bedrock uses the AWS SDK, which does not bundle for a V8 isolate. " +
    "Reach Bedrock through an OpenAI-compatible gateway, or run that model in " +
    "the workspace rather than the cell.",
};

export const SET_NAME = "all";

export function listProviders() {
  return builtinProviders().map((p) => p.id).filter((id) => !UNSUPPORTED[id]);
}

export function lookupModel({ provider, modelId, baseUrl }) {
  if (UNSUPPORTED[provider]) throw new Error(UNSUPPORTED[provider]);
  const record = builtinProviders().find((p) => p.id === provider);
  if (!record) throw new Error(`unknown provider '${provider}'. pi ships: ${listProviders().join(", ")}`);
  // An unknown model id is not an error: providers ship models faster than a
  // catalogue is regenerated. Fall back to the provider's defaults and let the
  // call fail with the provider's own message if the id really is wrong.
  let model;
  try { model = getBuiltinModel(provider, modelId); } catch { model = undefined; }
  model ??= {
    id: modelId, name: modelId, api: record.api ?? "openai-completions",
    provider, baseUrl: record.baseUrl, reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return { ...model, baseUrl: baseUrl || model.baseUrl };
}

export function streamFor(provider) {
  const record = builtinProviders().find((p) => p.id === provider);
  if (!record) throw new Error(`unknown provider '${provider}'`);
  return (model, context, options) => record.streamSimple(model, context, options);
}
