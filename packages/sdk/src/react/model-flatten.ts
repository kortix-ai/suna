import type { Model } from '@opencode-ai/sdk/v2/client';
import { GATEWAY_PROVIDER_IDS, type ProviderListResponse } from './use-opencode-sessions';

/**
 * Some provider payloads aren't the full opencode `Model` shape — notably the
 * synthetic "kortix" provider built from the project llm-catalog endpoint
 * (see `projectLlmCatalogToProviderList`), whose models carry a flatter,
 * models.dev-ish shape instead of `Model.capabilities`/`Model.cost`/etc. This
 * union covers both without lying about the shape via `any`; every field
 * access below is narrowed via `hasCapabilities` rather than cast.
 */
type LooseModel =
  | Model
  | {
      id?: string;
      name?: string;
      variants?: Record<string, Record<string, unknown>>;
      reasoning?: boolean;
      tool_call?: boolean;
      modalities?: { input?: string[]; output?: string[] };
      limit?: { context?: number; output?: number };
      release_date?: string;
      family?: string;
      cost?: { input?: number; output?: number };
      // The REAL upstream provider this model resolves against — see
      // `FlatModel.provider` below. Absent on plain opencode `Model` values
      // (which don't carry it); present on every gateway-served model.
      provider?: string;
      reasoning_options?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
      description?: string;
      open_weights?: boolean;
      last_updated?: string;
    };

function hasCapabilities(model: LooseModel): model is Model {
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
  /**
   * The REAL upstream provider this model resolves against ('anthropic',
   * 'openai', 'codex', 'kortix', ...) — carried explicitly off the gateway's
   * served model so the picker never has to recover it by string-splitting
   * `modelID`. Every gateway model is registered under `providerID: 'kortix'`;
   * this is the field that identifies who ACTUALLY serves it. Undefined for
   * providers/models predating this field.
   */
  provider?: string;
  /** Tunable reasoning-effort values (models.dev's `reasoning_options`), when
   *  the model exposes one. */
  reasoningOptions?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
  /** Free-text blurb models.dev publishes for the model. */
  description?: string;
  /** True when the model's weights are publicly released (open-weights) vs.
   *  closed API-only. models.dev's `open_weights` field, mirrored. */
  openWeights?: boolean;
  /** When models.dev last refreshed this model's own entry. */
  lastUpdated?: string;
}

// The gateway-specific fields (`provider`, `reasoning_options`,
// `description`, `open_weights`, `last_updated`) exist only on the
// loose/synthetic branch of `LooseModel`, never on opencode's own canonical
// `Model` type — read them via this narrow shape rather than widening
// `LooseModel`'s member access rules or reaching for `any`.
type WithGatewayFields = {
  provider?: string;
  reasoning_options?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
  description?: string;
  open_weights?: boolean;
  last_updated?: string;
};

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
        const caps = model.capabilities;
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
        provider: (model as WithGatewayFields).provider,
        reasoningOptions: (model as WithGatewayFields).reasoning_options,
        description: (model as WithGatewayFields).description,
        openWeights: (model as WithGatewayFields).open_weights,
        lastUpdated: (model as WithGatewayFields).last_updated,
      });
    }
  }
  return result;
}
