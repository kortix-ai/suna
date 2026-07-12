import { GATEWAY_PROVIDER_IDS, type ProviderListResponse } from './use-runtime-sessions';

/**
 * Some provider payloads aren't the full opencode `Model` shape — notably the
 * synthetic "kortix" provider built from the project llm-catalog endpoint
 * (see `projectLlmCatalogToProviderList`), whose models carry a flatter,
 * models.dev-ish shape instead of `Model.capabilities`/`Model.cost`/etc. This
 * union covers both without lying about the shape via `any`; every field
 * access below is narrowed via `hasCapabilities` rather than cast.
 */
type LooseModel = any;

function hasCapabilities(model: LooseModel): boolean {
  return 'capabilities' in model && model.capabilities != null;
}

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
    for (const [modelID, model] of Object.entries(p.models) as Array<[string, LooseModel]>) {
      // Narrow `model` itself (not a copy) so the loose-shape-only fields
      // (`reasoning`, `tool_call`, `modalities`) are safe to read below.
      let capabilities: FlatModel['capabilities'];
      if (hasCapabilities(model)) {
        const caps = model.capabilities ?? {};
        capabilities = {
          reasoning: caps.reasoning ?? false,
          vision: caps.input?.image ?? false,
          toolcall: caps.toolcall ?? false,
        };
      } else {
        capabilities = {
          reasoning: model.reasoning ?? false,
          vision: model.modalities?.input?.includes('image') ?? false,
          toolcall: model.tool_call ?? false,
        };
      }
      result.push({
        providerID: p.id,
        providerName: p.name,
        modelID,
        modelName: (model.name || modelID).replace('(latest)', '').trim(),
        variants: model.variants,
        capabilities,
        contextWindow: model.limit?.context,
        releaseDate: model.release_date,
        family: model.family,
        cost: model.cost
          ? {
              input: model.cost.input ?? 0,
              output: model.cost.output ?? 0,
            }
          : undefined,
        providerSource: p.source,
      });
    }
  }
  return result;
}
