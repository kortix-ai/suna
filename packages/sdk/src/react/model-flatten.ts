import { GATEWAY_PROVIDER_IDS, type ProviderListResponse } from './use-opencode-sessions';

/**
 * Flat model list + the flattening logic (relocated from web's session-chat-input —
 * it's data, not UI). Used by the model/agent resolution hooks.
 */
export interface FlatModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  variants?: Record<string, Record<string, unknown>>;
  /** Capabilities extracted from the provider API response */
  capabilities?: {
    reasoning?: boolean;
    vision?: boolean;
    toolcall?: boolean;
  };
  /** Context window size in tokens */
  contextWindow?: number;
  /** ISO date string for release date */
  releaseDate?: string;
  /** Model family (used for "latest" logic) */
  family?: string;
  /** Cost per token (input/output) */
  cost?: {
    input: number;
    output: number;
  };
  /** Provider source (env, api, config, custom) */
  providerSource?: string;
}

export function flattenModels(providers: ProviderListResponse | undefined): FlatModel[] {
  if (!providers) return [];
  const all = Array.isArray(providers.all) ? providers.all : [];
  const connected = Array.isArray(providers.connected) ? providers.connected : [];
  const result: FlatModel[] = [];
  for (const p of all) {
    if (!connected.includes(p.id)) continue;
    // Defense in depth: the provider list is already source-filtered to the
    // gateway, but never render a native (bypass) provider even if one slips in.
    if (!GATEWAY_PROVIDER_IDS.has(p.id)) continue;
    for (const [modelID, model] of Object.entries(p.models)) {
      const caps = (model as any).capabilities;
      const modalities = (model as any).modalities;
      result.push({
        providerID: p.id,
        providerName: p.name,
        modelID,
        modelName: (model.name || modelID).replace('(latest)', '').trim(),
        variants: model.variants,
        capabilities: caps
          ? {
              reasoning: caps.reasoning ?? false,
              vision: caps.input?.image ?? false,
              toolcall: caps.toolcall ?? false,
            }
          : {
              reasoning: (model as any).reasoning ?? false,
              vision: modalities?.input?.includes('image') ?? false,
              toolcall: (model as any).tool_call ?? false,
            },
        contextWindow: (model as any).limit?.context,
        releaseDate: (model as any).release_date,
        family: (model as any).family,
        cost: (model as any).cost
          ? {
              input: (model as any).cost.input ?? 0,
              output: (model as any).cost.output ?? 0,
            }
          : undefined,
        providerSource: (p as any).source,
      });
    }
  }
  return result;
}
