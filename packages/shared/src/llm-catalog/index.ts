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
  //   'openrouter'   → an OpenRouter slug (`openrouter/fusion`)
  //   'opencode-zen' → an OpenCode Zen public model id (`deepseek-v4-flash-free`)
  upstreamModelId: string;
  // Which upstream + wire format carries it:
  //   'bedrock'      → Anthropic-on-Bedrock InvokeModel payload (Claude only)
  //   'openrouter'   → OpenRouter openai-compatible chat completions
  //   'opencode-zen' → OpenCode Zen openai-compatible chat completions (no auth)
  transport: "bedrock" | "openrouter" | "opencode-zen";
  // models.dev id for live pricing — upstream ids don't always match the catalog.
  pricingRef: string;
  tier: "flagship" | "balanced" | "fast" | "free";
  free?: boolean;
  // Vision (image input). Curated explicitly: managed slugs don't all exist on
  // models.dev (z-ai≠zhipuai, qwen≠alibaba, dotted vs dashed Claude ids), so
  // unlike BYOK models these can't derive it from the generated catalog.
  vision: boolean;
  // Context/output token window. Lives here (same reason as `vision`: managed
  // slugs aren't reliably on models.dev) and is served verbatim so OpenCode can
  // size the conversation and fire auto-compaction. This is the CANONICAL home —
  // it used to be backfilled from a hardcoded table in the sandbox agent server.
  limit: { context: number; output: number };
  // Curated USD-per-1M-token pricing. Curated here (same reason as `vision`/
  // `limit`): managed slugs don't reliably resolve on models.dev, and the
  // provider-prefixed `pricingRef` never matches the bare models.dev keys, so a
  // live lookup returns undefined — a billable managed turn would then price to
  // $0 and silently leak (notably Bedrock/Claude, whose responses carry no cost
  // hint). This is the descriptor pricing FALLBACK; a live upstream cost hint
  // (e.g. OpenRouter's usage.cost) still takes precedence in calculateCost.
  pricing: { input: number; output: number; cacheRead?: number };
}

// Managed model ids are single-segment (no `provider/` prefix). They are served
// to opencode under the `kortix` provider, so opencode references them as
// `kortix/<id>` (e.g. `kortix/claude-opus-4.8`) and sends `<id>` as the wire
// model. A bare, slash-free id is what lets the gateway tell a managed request
// (`claude-opus-4.8` → our keys, credits-billed) apart from a BYOK one
// (`anthropic/claude-...` → the user's own key) without the two ever colliding.
//
// Every managed paid model runs through OUR keys and is billed as Kortix credits
// with markup, so the gateway enforces budgets/logging/spend on all of them.
// Claude runs on Bedrock (the proven Anthropic-payload InvokeModel transport);
// everything else paid (GLM, Qwen, DeepSeek) goes via OpenRouter. The curated
// OpenCode Zen free set is also managed here: it is exposed under the `kortix`
// provider and recorded by the gateway, not shown as a separate native
// `opencode` provider in the gateway picker.
export const DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
] as const;

const OPENCODE_ZEN_FREE_MODELS: ManagedModel[] = [
  {
    id: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash Free",
    upstreamModelId: "deepseek-v4-flash-free",
    transport: "opencode-zen",
    pricingRef: "opencode/deepseek-v4-flash-free",
    tier: "free",
    free: true,
    vision: false,
    limit: { context: 200_000, output: 128_000 },
    // Free (billingMode 'none') — never billed; pricing recorded as $0.
    pricing: { input: 0, output: 0 },
  },
  {
    id: "mimo-v2.5-free",
    name: "MiMo V2.5 Free",
    upstreamModelId: "mimo-v2.5-free",
    transport: "opencode-zen",
    pricingRef: "opencode/mimo-v2.5-free",
    tier: "free",
    free: true,
    vision: true,
    limit: { context: 200_000, output: 32_000 },
    pricing: { input: 0, output: 0 },
  },
  {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    upstreamModelId: "nemotron-3-ultra-free",
    transport: "opencode-zen",
    pricingRef: "opencode/nemotron-3-ultra-free",
    tier: "free",
    free: true,
    vision: false,
    limit: { context: 1_000_000, output: 128_000 },
    pricing: { input: 0, output: 0 },
  },
  {
    id: "north-mini-code-free",
    name: "North Mini Code Free",
    upstreamModelId: "north-mini-code-free",
    transport: "opencode-zen",
    pricingRef: "opencode/north-mini-code-free",
    tier: "free",
    free: true,
    vision: false,
    limit: { context: 256_000, output: 64_000 },
    pricing: { input: 0, output: 0 },
  },
];

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
    // Bedrock/Claude responses carry NO cost hint, so this curated table is the
    // sole pricing source — without it this turn priced to $0. cacheRead ≈ 10% of
    // input (Anthropic prompt-cache read rate).
    pricing: { input: 5, output: 25, cacheRead: 0.5 },
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
    pricing: { input: 3, output: 15, cacheRead: 0.3 },
  },
  {
    id: "fusion",
    name: "Fusion",
    upstreamModelId: "openrouter/fusion",
    transport: "openrouter",
    pricingRef: "openrouter/fusion",
    tier: "balanced",
    vision: false,
    limit: { context: 1_000_000, output: 128_000 },
    // OpenRouter returns a live usage.cost that takes precedence; this is the
    // fallback used only if that hint is ever absent.
    pricing: { input: 1, output: 3 },
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
    pricing: { input: 1.2, output: 6 },
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
    pricing: { input: 0.435, output: 0.87 },
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
    pricing: { input: 0.0983, output: 0.1966 },
  },
  ...OPENCODE_ZEN_FREE_MODELS,
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
// For now AUTO is Fusion (OpenRouter's multi-model router) except a request that
// carries images is routed to a vision-capable model so attachments aren't
// silently ignored (Fusion is text-only). The `autoRouter` hook and this single
// indirection point are where a future, more sophisticated per-task handler plugs in.
export const AUTO_MODEL_ID = "auto";

const AUTO_TARGET_MODEL = "fusion"; // text-only default
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
  return requestHasImage(body) ? AUTO_VISION_MODEL : AUTO_TARGET_MODEL;
}

export const MODEL_SELECTOR_PROVIDER_IDS = [
  "kortix",
  "anthropic",
  "openai",
  "github-copilot",
  "openrouter",
  "vercel",
] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  codex: "ChatGPT",
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
