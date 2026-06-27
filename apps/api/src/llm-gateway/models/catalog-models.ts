import { resolveCatalogUpstream } from "@kortix/llm-gateway";
import {
  AUTO_MODEL_ID,
  CATALOG,
  type CatalogModel,
  MANAGED_MODELS,
} from "@kortix/shared/llm-catalog";
import { codexModelIds } from "./codex-models";

interface GatewayModel {
  name: string;
  released?: string | null;
  release_date?: string | null;
  family?: string;
  free?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
}

// Full catalog model (with models.dev-derived capability flags) by `provider/model` id.
const catalogModelById = new Map<string, CatalogModel>();
for (const provider of CATALOG.providers) {
  for (const model of provider.models) {
    catalogModelById.set(`${provider.id}/${model.id}`, model);
  }
}

function humanize(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

export function managedModels(opts?: {
  freeOnly?: boolean;
}): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  // AUTO is synthetic (not a real model): it accepts images because pickAutoModel
  // routes image-bearing requests to a vision-capable model. Its window matches
  // its default target (Fusion) so OpenCode sizes conversations the same. It stays
  // available to every tier — for a free account it resolves to a free model
  // (see pickAutoModel), so the default still works without exposing paid ones.
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
  // `freeOnly` drops the paid managed models so a free-tier account only ever sees
  // the free OpenCode-Zen lineup through the Kortix gateway.
  for (const m of MANAGED_MODELS) {
    if (opts?.freeOnly && !m.free) continue;
    out[m.id] = {
      name: m.name,
      free: m.free,
      reasoning: true,
      tool_call: true,
      attachment: m.vision,
      temperature: true,
      limit: m.limit,
    };
  }
  return out;
}

export function gatewayModelsAll(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const provider of CATALOG.providers) {
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

export function gatewayCodexModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const id of codexModelIds()) {
    const model = catalogModelById.get(`openai/${id}`);
    out[`codex/${id}`] = {
      name: `${model?.name ?? humanize(id)} (ChatGPT)`,
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

// The served catalog depends only on the committed CATALOG snapshot and process
// env (codex ids) — never on the caller. So the shapes are each built ONCE, at
// module load, instead of rebuilt (iterating ~5k models) on every /models
// request and sandbox boot. The `*_FREE` variants drop paid managed models for
// free-tier accounts; BYOK/codex are unchanged (a free user's own connected
// keys keep working).
const MANAGED_ONLY: Record<string, GatewayModel> = managedModels();
const MANAGED_FREE_ONLY: Record<string, GatewayModel> = managedModels({
  freeOnly: true,
});
const BYOK_AND_CODEX: Record<string, GatewayModel> = {
  ...gatewayModelsAll(),
  ...gatewayCodexModels(),
};
const FULL_CATALOG: Record<string, GatewayModel> = {
  ...MANAGED_ONLY,
  ...BYOK_AND_CODEX,
};
const FREE_FULL_CATALOG: Record<string, GatewayModel> = {
  ...MANAGED_FREE_ONLY,
  ...BYOK_AND_CODEX,
};

// `projectId` gates BYOK/codex visibility (anonymous callers see managed only).
// `freeManagedOnly` (a free-tier account with internal billing on) hides paid
// managed models so the picker + sandbox only ever surface free models through
// the Kortix gateway. All four shapes are shared singletons — no per-call build.
export function gatewayModelCatalog(
  projectId: string | undefined,
  opts?: { freeManagedOnly?: boolean },
): Record<string, GatewayModel> {
  if (opts?.freeManagedOnly) {
    return projectId ? FREE_FULL_CATALOG : MANAGED_FREE_ONLY;
  }
  return projectId ? FULL_CATALOG : MANAGED_ONLY;
}
