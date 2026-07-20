import { normalizeProviderList } from '@/hooks/opencode/provider-selection';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import type { GatewayCatalogModel } from '@kortix/sdk';

// ============================================================================
// Flat model list helper
// ============================================================================

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
  /** True for zero-cost managed models exposed by the gateway. */
  free?: boolean;
  /** Provider source (env, api, config, custom) */
  providerSource?: string;
  /**
   * The REAL upstream provider this model resolves against ('anthropic',
   * 'openai', 'amazon-bedrock', ...) — carried explicitly off the gateway's
   * served model (`GatewayModel.provider`, apps/api's catalog-models.ts, typed
   * on the wire as `GatewayCatalogModel.provider`) so the picker never has to
   * recover it by string-splitting `modelID`. Every gateway model is
   * registered under `providerID: 'kortix'`; this is the field that identifies
   * who ACTUALLY serves it. Falls back to undefined for providers/models
   * predating this field (e.g. a stale baked catalog on an old sandbox image)
   * — consumers should still fall back to splitting `modelID` in that case.
   */
  provider?: string;
  /** Tunable reasoning-effort values (models.dev's `reasoning_options`), when
   *  the model exposes one — same shape the composer's effort selector reads
   *  off the baked/live catalog, threaded onto the live per-session model too. */
  reasoningOptions?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
  /** Free-text blurb models.dev publishes for the model. */
  description?: string;
  /** True when the model's weights are publicly released (open-weights) vs.
   *  closed API-only. models.dev's `open_weights` field, mirrored. */
  openWeights?: boolean;
  /** When models.dev last refreshed this model's own entry. */
  lastUpdated?: string;
}

/**
 * The subset of opencode's canonical `Model` this flattener reads. Declared
 * structurally rather than imported from `@opencode-ai/sdk` because apps/web
 * consumes the provider list through its own re-exported types; only these
 * fields are ever touched here, and the `capabilities` object is what
 * distinguishes an opencode model from a gateway one.
 */
interface OpencodeCatalogModel {
  name?: string;
  family?: string;
  variants?: Record<string, Record<string, unknown>>;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  capabilities?: {
    reasoning?: boolean;
    toolcall?: boolean;
    input?: { image?: boolean };
  };
}

/**
 * A provider's `models` map holds either opencode's canonical model shape
 * (native providers) or the flatter, models.dev-ish `GatewayCatalogModel`
 * served by the synthetic `kortix` gateway provider. The two are structurally
 * overlapping and every field is optional on the wire, so this is modelled as
 * an intersection of both shapes rather than a discriminated union — a union
 * cannot be narrowed by a `capabilities` check (both members have only
 * optional properties, so TypeScript can't subtract one from the other).
 *
 * The point of naming the shape at all is that it keeps `provider` and the
 * models.dev passthrough fields type-checked end to end: this file used to
 * recover all of them with `(model as any)` casts because
 * `ProjectLlmCatalogResponse` never declared them.
 */
type LooseModel = OpencodeCatalogModel & Partial<GatewayCatalogModel>;

/** Opencode's canonical shape nests capabilities; the gateway's is flat. */
function hasCapabilities(
  model: LooseModel,
): model is LooseModel & { capabilities: NonNullable<OpencodeCatalogModel['capabilities']> } {
  return model.capabilities != null;
}

function catalogModelFor(providerID: string, modelID: string) {
  let lookupProviderID = providerID;
  let lookupModelID = modelID;
  if (providerID === 'kortix') {
    const slash = modelID.indexOf('/');
    if (slash !== -1) {
      lookupProviderID = modelID.slice(0, slash);
      lookupModelID = modelID.slice(slash + 1);
    }
  }
  return LLM_PROVIDER_BY_ID.get(lookupProviderID)?.models.find(
    (model) => model.id === lookupModelID,
  );
}

export function flattenModels(providers: ProviderListResponse | undefined): FlatModel[] {
  if (!providers) return [];
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const connected = Array.isArray(normalized.connected) ? normalized.connected : [];
  const result: FlatModel[] = [];
  for (const p of all) {
    if (!connected.includes(p.id)) continue;
    for (const [modelID, model] of Object.entries(p.models) as Array<[string, LooseModel]>) {
      const catalogModel = catalogModelFor(p.id, modelID);
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
        modelName: (model.name || catalogModel?.name || modelID).replace('(latest)', '').trim(),
        variants: model.variants,
        capabilities,
        contextWindow: model.limit?.context,
        releaseDate: model.release_date ?? model.released ?? catalogModel?.released ?? undefined,
        family: model.family,
        cost: model.cost
          ? {
              input: model.cost.input ?? 0,
              output: model.cost.output ?? 0,
            }
          : undefined,
        free: model.free === true,
        providerSource: p.source,
        provider: model.provider,
        reasoningOptions: model.reasoning_options,
        description: model.description,
        openWeights: model.open_weights,
        lastUpdated: model.last_updated,
      });
    }
  }
  return result;
}
