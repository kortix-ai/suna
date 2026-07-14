import {
  AUTO_MODEL_ID,
  type Catalog,
  type CatalogModel,
} from "@kortix/llm-catalog";
import { resolveCatalogUpstream } from './provider-registry';
import { codexModelIds } from "./codex-models";
import { runtimeModelCatalog } from './runtime-catalog';
import { RUNTIME_MANAGED_MODELS } from './managed-models';

interface GatewayModel {
  name: string;
  released?: string | null;
  release_date?: string | null;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
}

function modelsById(catalog: Catalog): Map<string, CatalogModel> {
  const byId = new Map<string, CatalogModel>();
  for (const provider of catalog.providers) {
    for (const model of provider.models) byId.set(`${provider.id}/${model.id}`, model);
  }
  return byId;
}

function humanize(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function codexName(id: string): string {
  if (!id.startsWith('gpt-')) return humanize(id);
  return id
    .split('-')
    .map((part, index) => index === 0 ? 'GPT' : index >= 2 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part)
    .join('-');
}

// Conservative context window for any model models.dev doesn't declare one for.
// The gateway guarantees EVERY served model carries a `limit` — OpenCode does NOT
// pull limits from models.dev for a custom provider, so this is the single source
// the client trusts to size conversations + fire auto-compaction (it does no
// backfill of its own). Better to compact a little early than never.
const DEFAULT_SERVED_LIMIT = { context: 200_000, output: 32_000 } as const;

// Coerce a (possibly partial or zero) models.dev limit into a guaranteed-positive
// window. Some non-chat catalog entries (whisper audio, NVIDIA video/TTS models)
// report context:0 — fall back to the default so EVERY served model can be sized.
function servedLimit(limit?: { context?: number; output?: number }): {
  context: number;
  output: number;
} {
  return {
    context:
      limit?.context && limit.context > 0
        ? limit.context
        : DEFAULT_SERVED_LIMIT.context,
    output:
      limit?.output && limit.output > 0
        ? limit.output
        : DEFAULT_SERVED_LIMIT.output,
  };
}

// Capability flags for a served model. models.dev is the single source of truth:
// an enriched catalog entry (capabilities present) is used verbatim; a model
// models.dev doesn't carry falls back to permissive legacy defaults so it isn't
// crippled. See apps/web/scripts/enrich-llm-catalog-capabilities.ts.
function capabilitiesOf(
  model: CatalogModel | undefined,
): Omit<GatewayModel, "name"> {
  if (model && model.attachment !== undefined) {
    return {
      reasoning: !!model.reasoning,
      tool_call: !!model.tool_call,
      attachment: !!model.attachment,
      temperature: !!model.temperature,
      limit: servedLimit(model.limit),
    };
  }
  return {
    reasoning: true,
    tool_call: true,
    attachment: false,
    temperature: false,
    limit: servedLimit(undefined),
  };
}

export function managedModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  // AUTO is synthetic (not a real model): it accepts images because pickAutoModel
  // routes image-bearing requests to a vision-capable model. Its window matches
  // its default target so OpenCode sizes conversations the same.
  out[AUTO_MODEL_ID] = {
    name: "Auto",
    reasoning: false,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 128_000 },
  };
  // The managed lineup is curated and its slugs don't all exist on models.dev
  // (z-ai≠zhipuai, dotted vs dashed Claude ids), so vision + limit are explicit
  // on each model. All current managed models support reasoning/tools/temperature.
  for (const m of RUNTIME_MANAGED_MODELS) {
    out[m.id] = {
      name: m.name,
      reasoning: true,
      tool_call: true,
      attachment: m.vision,
      temperature: true,
      limit: m.limit,
    };
  }
  return out;
}

export function gatewayModelsAll(
  catalog: Catalog = runtimeModelCatalog.snapshot(),
): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const provider of catalog.providers) {
    if (provider.id === "opencode") continue;
    if (!resolveCatalogUpstream(provider.id)) continue;
    for (const model of provider.models) {
      // BYOK models ARE catalog entries — capabilities come straight from models.dev.
      out[`${provider.id}/${model.id}`] = {
        name: model.name,
        released: model.released,
        release_date: model.released,
        family: (model as { family?: string }).family,
        ...capabilitiesOf(model),
      };
    }
  }
  return out;
}

export function gatewayCodexModels(
  catalog: Catalog = runtimeModelCatalog.snapshot(),
): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  const catalogModelById = modelsById(catalog);
  for (const id of codexModelIds()) {
    const model = catalogModelById.get(`openai/${id}`);
    out[`codex/${id}`] = {
      name: `${model?.name ?? codexName(id)} (ChatGPT)`,
      released: model?.released,
      release_date: model?.released,
      family: (model as { family?: string } | undefined)?.family,
      // Derive from models.dev; default to GPT-5.x's profile (reasoning, tools,
      // vision) for any id models.dev doesn't list yet.
      reasoning: model?.reasoning ?? true,
      tool_call: model?.tool_call ?? true,
      attachment: model?.attachment ?? true,
      temperature: model?.temperature ?? false,
      limit: servedLimit(model?.limit),
    };
  }
  return out;
}

// Runtime catalog shapes are rebuilt once per atomic API refresh revision, not
// once per request. The bundled snapshot is only the initial/last-known fallback.
const MANAGED_ONLY: Record<string, GatewayModel> = managedModels();
const EMPTY_CATALOG: Record<string, GatewayModel> = {};
let cachedRevision = -1;
let cachedByokAndCodex: Record<string, GatewayModel> = {};
let cachedFullCatalog: Record<string, GatewayModel> = MANAGED_ONLY;

function refreshedCatalogs(): {
  byokAndCodex: Record<string, GatewayModel>;
  full: Record<string, GatewayModel>;
} {
  const revision = runtimeModelCatalog.status().revision;
  if (revision !== cachedRevision) {
    const catalog = runtimeModelCatalog.snapshot();
    cachedByokAndCodex = {
      ...gatewayModelsAll(catalog),
      ...gatewayCodexModels(catalog),
    };
    cachedFullCatalog = { ...MANAGED_ONLY, ...cachedByokAndCodex };
    cachedRevision = revision;
  }
  return { byokAndCodex: cachedByokAndCodex, full: cachedFullCatalog };
}

// `projectId` gates BYOK/codex visibility (anonymous callers see managed only).
// `freeManagedOnly` (a free-tier account with internal billing on) hides every
// managed Kortix model. A free user's own connected provider keys still work,
// but there is no unreliable platform-managed free default.
export function gatewayModelCatalog(
  projectId: string | undefined,
  opts?: { freeManagedOnly?: boolean },
): Record<string, GatewayModel> {
  const catalogs = refreshedCatalogs();
  if (opts?.freeManagedOnly) {
    return projectId ? catalogs.byokAndCodex : EMPTY_CATALOG;
  }
  return projectId ? catalogs.full : MANAGED_ONLY;
}
