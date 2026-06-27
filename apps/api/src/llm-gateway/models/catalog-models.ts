import {
  AUTO_MODEL_ID,
  CATALOG,
  type CatalogModel,
  MANAGED_MODELS,
} from "@kortix/shared/llm-catalog";
import { codexModelIds } from "./codex-models";

// ── Catalog upstream resolution (inlined) ───────────────────────────────────
// Whether a models.dev catalog provider can be served as a BYOK provider in the
// served catalog: it needs a recognized SDK kind (anthropic or openai-compat), a
// resolvable base URL, and an API-key env var. Inlined from the retired
// @kortix/llm-gateway package — the slim managed endpoint no longer depends on
// the gateway, and this is the only bit catalog-models needs.
const OPENAI_COMPATIBLE_NPM = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/azure",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/xai",
  "@ai-sdk/cerebras",
  "@ai-sdk/togetherai",
  "@ai-sdk/deepinfra",
  "@ai-sdk/perplexity",
  "@ai-sdk/vercel",
  "@ai-sdk/gateway",
  "@openrouter/ai-sdk-provider",
]);
const ANTHROPIC_NPM = "@ai-sdk/anthropic";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const BASE_URL_FALLBACKS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  "x-ai": "https://api.x.ai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
  v0: "https://api.v0.dev/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  togetherai: "https://api.together.xyz/v1",
};

function providerKind(npm: string | null | undefined): "anthropic" | "openai-compat" | null {
  if (!npm) return null;
  if (npm === ANTHROPIC_NPM) return "anthropic";
  if (OPENAI_COMPATIBLE_NPM.has(npm)) return "openai-compat";
  return null;
}

function canServeCatalogProvider(provider: {
  id: string;
  npm?: string | null;
  api?: string | null;
  env?: string[];
}): boolean {
  const kind = providerKind(provider.npm);
  if (!kind) return false;
  const baseUrl =
    kind === "anthropic" ? ANTHROPIC_BASE_URL : provider.api || BASE_URL_FALLBACKS[provider.id];
  if (!baseUrl) return false;
  return !!provider.env?.[0];
}

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

export function managedModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  // AUTO is synthetic (not a real model): it accepts images because pickAutoModel
  // routes image-bearing requests to a vision-capable model. Its window matches
  // its default target (Fusion) so OpenCode sizes conversations the same.
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
  for (const m of MANAGED_MODELS) {
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
    if (!canServeCatalogProvider(provider)) continue;
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
// env (codex ids) — never on the caller. So the two shapes are each built ONCE,
// at module load, instead of rebuilt (iterating ~5k models) on every /models
// request and sandbox boot.
const MANAGED_ONLY: Record<string, GatewayModel> = managedModels();
const FULL_CATALOG: Record<string, GatewayModel> = {
  ...MANAGED_ONLY,
  ...gatewayModelsAll(),
  ...gatewayCodexModels(),
};

// `projectId` gates BYOK/codex visibility (anonymous callers see managed only) —
// it is NOT a per-project filter, so both shapes are shared singletons.
export function gatewayModelCatalog(
  projectId: string | undefined,
): Record<string, GatewayModel> {
  return projectId ? FULL_CATALOG : MANAGED_ONLY;
}
