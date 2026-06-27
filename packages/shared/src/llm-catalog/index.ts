import catalogJson from "./catalog.generated.json" with { type: "json" };

export interface CatalogModel {
  id: string;
  name: string;
  released?: string | null;
  // Capabilities mirrored from models.dev by
  // apps/web/scripts/enrich-llm-catalog-capabilities.ts.
  // Single source of truth — consumers derive flags from these, never hardcode.
  attachment?: boolean; // image / file input (vision)
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
}

interface CatalogProvider {
  id: string;
  name: string;
  env?: string[];
  doc?: string;
  api?: string | null;
  npm?: string | null;
  models: CatalogModel[];
}

export interface Catalog {
  source: string;
  fetched_at: string;
  provider_count: number;
  model_count: number;
  providers: CatalogProvider[];
}

export const CATALOG = catalogJson as Catalog;

export interface ManagedModel {
  id: string;
  name: string;
  // The upstream's own model id, interpreted per `transport`:
  //   'bedrock'      → a Bedrock id (`us.anthropic.claude-opus-4-8`)
  //   'openrouter'   → an OpenRouter slug (`z-ai/glm-5.2`)
  upstreamModelId: string;
  // Which upstream + wire format carries it:
  //   'bedrock'      → Anthropic-on-Bedrock InvokeModel payload (Claude only)
  //   'openrouter'   → OpenRouter openai-compatible chat completions
  transport: "bedrock" | "openrouter";
  // models.dev id for live pricing — upstream ids don't always match the catalog.
  pricingRef: string;
  tier: "flagship" | "balanced" | "fast";
  // Vision (image input). Curated explicitly: managed slugs don't all exist on
  // models.dev (z-ai≠zhipuai, qwen≠alibaba, dotted vs dashed Claude ids), so
  // unlike BYOK models these can't derive it from the generated catalog.
  vision: boolean;
  // Context/output token window. Lives here (same reason as `vision`: managed
  // slugs aren't reliably on models.dev) and is served verbatim so OpenCode can
  // size the conversation and fire auto-compaction. This is the CANONICAL home —
  // it used to be backfilled from a hardcoded table in the sandbox agent server.
  limit: { context: number; output: number };
}

// Managed model ids are single-segment (no `provider/` prefix). They are served
// to opencode under the `kortix` provider, so opencode references them as
// `kortix/<id>` (e.g. `kortix/claude-opus-4.8`) and sends `<id>` as the wire
// model. A bare, slash-free id is what lets the gateway tell a managed request
// (`claude-opus-4.8` → our keys, credits-billed) apart from a BYOK one
// (`anthropic/claude-...` → the user's own key) without the two ever colliding.
//
// Every managed model runs through OUR keys and is billed as Kortix credits with
// markup, so the gateway enforces budgets/logging/spend on all of them. Claude
// runs on Bedrock (the proven Anthropic-payload InvokeModel transport);
// everything else goes via OpenRouter.
export const MANAGED_MODELS: ManagedModel[] = [
  {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
    upstreamModelId: "us.anthropic.claude-opus-4-8",
    transport: "bedrock",
    pricingRef: "anthropic/claude-opus-4.8",
    tier: "flagship",
    vision: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    upstreamModelId: "us.anthropic.claude-sonnet-4-6",
    transport: "bedrock",
    pricingRef: "anthropic/claude-sonnet-4.6",
    tier: "balanced",
    vision: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    upstreamModelId: "z-ai/glm-5.2",
    transport: "openrouter",
    pricingRef: "z-ai/glm-5.2",
    tier: "balanced",
    vision: false,
    limit: { context: 1_000_000, output: 131_072 },
  },
  {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    upstreamModelId: "qwen/qwen3.7-max",
    transport: "openrouter",
    pricingRef: "qwen/qwen3.7-max",
    tier: "balanced",
    vision: false,
    limit: { context: 1_048_576, output: 64_000 },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    upstreamModelId: "deepseek/deepseek-v4-pro",
    transport: "openrouter",
    pricingRef: "deepseek/deepseek-v4-pro",
    tier: "balanced",
    vision: false,
    limit: { context: 1_048_576, output: 64_000 },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    upstreamModelId: "deepseek/deepseek-v4-flash",
    transport: "openrouter",
    pricingRef: "deepseek/deepseek-v4-flash",
    tier: "balanced",
    vision: false,
    limit: { context: 1_048_576, output: 64_000 },
  },
];

const MANAGED_BY_ID = new Map(MANAGED_MODELS.map((m) => [m.id, m] as const));

export function getManagedModel(id: string): ManagedModel | undefined {
  return MANAGED_BY_ID.get(id);
}

export function isManagedModelId(id: string): boolean {
  return MANAGED_BY_ID.has(id);
}

export const DEFAULT_MANAGED_MODEL_IDS = MANAGED_MODELS.map((m) => m.id);

export const MANAGED_FLAGSHIP_MODEL_ID = (
  MANAGED_MODELS.find((m) => m.tier === "flagship") ?? MANAGED_MODELS[0]
).id;

// ─── AUTO: managed model selection ──────────────────────────────────────────
// The catalog advertises a synthetic `auto` model presented to users as
// "automatically picks the cheapest, most efficient model for the task." When a
// request asks for it, the gateway resolves it to a concrete managed model and
// bills it as the resolved model.
//
// AUTO resolves to GLM 5.2 (text) except a request that carries images, which is
// routed to a vision-capable model so attachments aren't silently ignored (GLM is
// text-only). The `autoRouter` hook and this single indirection point are where a
// future, more sophisticated per-task handler plugs in.
//
// AUTO is currently HIDDEN from the picker (see AUTO_MODEL_ENABLED): every session
// explicitly opts into a concrete model. The resolution path below stays fully
// intact — the sandbox still defaults `small_model`/headless sessions to `auto`,
// and a stale gateway caller asking for raw `auto` still resolves — so re-exposing
// the toggle is a one-line flip.
export const AUTO_MODEL_ID = "auto";

// Whether AUTO is exposed in the model picker. Off for now: we want an explicit
// opt-in on which model to use, and will bring AUTO back later. The web app reads
// this through `featureFlags.enableAutoModel`, which can override it per-deploy via
// NEXT_PUBLIC_ENABLE_AUTO_MODEL. The server keeps serving + resolving `auto`
// regardless, so this only gates the UI.
export const AUTO_MODEL_ENABLED = false;

// The single "what to choose for auto" knob: the model AUTO routes text requests
// to, AND the concrete model a fresh session defaults to while AUTO is hidden.
// Change this one constant to re-point both.
export const AUTO_DEFAULT_MODEL_ID = "glm-5.2";

const AUTO_TARGET_MODEL = AUTO_DEFAULT_MODEL_ID; // text-only default
const AUTO_VISION_MODEL = "claude-sonnet-4.6"; // when the request has image content

function requestHasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (
      Array.isArray(content) &&
      content.some(
        (part) =>
          !!part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "image_url",
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Map a requested model to a concrete managed model when (and only when) it is
 * the synthetic `auto` id. Returns null for any other model (a no-op pass-through
 * the caller treats as "use the requested model as-is"). Pure + dependency-free
 * so both the in-process mount and the standalone gateway can call it locally.
 */
export function pickAutoModel(
  model: string,
  body: Record<string, unknown>,
): string | null {
  if (model !== AUTO_MODEL_ID && model !== `kortix/${AUTO_MODEL_ID}`)
    return null;
  const hasImage = requestHasImage(body);
  return hasImage ? AUTO_VISION_MODEL : AUTO_TARGET_MODEL;
}

export const MODEL_SELECTOR_PROVIDER_IDS = [
  "kortix",
  "opencode",
  "anthropic",
  "openai",
  "github-copilot",
  "google",
  "openrouter",
  "vercel",
] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  codex: "ChatGPT",
  google: "Google",
  xai: "xAI",
  moonshotai: "Moonshot",
  "moonshotai-cn": "Moonshot",
  opencode: "OpenCode Zen",
  kortix: "Kortix",
  firmware: "Firmware",
  bedrock: "AWS Bedrock",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  vercel: "Vercel",
  groq: "Groq",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  cohere: "Cohere",
  llama: "Llama",
  huggingface: "Hugging Face",
  cerebras: "Cerebras",
  togetherai: "Together AI",
  fireworks: "Fireworks",
  deepinfra: "DeepInfra",
  nvidia: "NVIDIA",
  cloudflare: "Cloudflare",
  azure: "Azure",
  ollama: "Ollama",
  perplexity: "Perplexity",
  lmstudio: "LM Studio",
  v0: "v0",
  wandb: "W&B",
  baseten: "Baseten",
  minimax: "Moonshot",
  "minimax-cn": "Moonshot",
  siliconflow: "SiliconFlow",
  "siliconflow-cn": "SiliconFlow",
  zhipuai: "ZhipuAI",
  "zhipuai-cn": "ZhipuAI",
  "google-vertex": "Google Vertex",
  "google-vertex-anthropic": "Vertex Anthropic",
  "azure-cognitive-services": "Azure Cognitive",
  "cloudflare-ai-gateway": "Cloudflare Gateway",
  "github-models": "GitHub Models",
  "ollama-cloud": "Ollama Cloud",
  "kai Coding Plan": "AI21",
  zaicodingplan: "AI21",
  venice: "Venice",
  upstage: "Upstage",
  nebius: "Nebius",
  vultr: "Vultr",
  friendli: "Friendli",
  poe: "Poe",
  requesty: "Requesty",
  "sap-ai-core": "SAP AI Core",
  scaleway: "Scaleway",
  inception: "Inception",
  morph: "Morph",
  abacus: "Abacus",
  bailing: "Bailing",
  chutes: "Chutes",
  fastrouter: "FastRouter",
  helicone: "Helicone",
  iflowcn: "iFlytek",
  inference: "Inference",
  "io-net": "IO.net",
  "kimi-for-coding": "Kimi",
  lucidquery: "LucidQuery",
  modelscope: "ModelScope",
  "nano-gpt": "NanoGPT",
  ovhcloud: "OVHcloud",
  submodel: "Submodel",
  synthetic: "Synthetic",
  xiaomi: "Xiaomi",
  zenmux: "Zenmux",
};
