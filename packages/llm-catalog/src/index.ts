import catalogJson from './catalog.generated.json' with { type: 'json' };

// ─── Kortix-owned provider auth requirements ────────────────────────────────
//
// *** THE PROBLEM THIS FIXES ***
// `CatalogProvider.env` (models.dev's `env` field, in catalog.generated.json)
// lists EVERY env var the upstream's OFFICIAL SDK recognizes across ALL of
// that SDK's supported auth methods — not what KORTIX's own gateway
// transport actually reads. Most providers have exactly one implemented auth
// method, so `env` happens to be the right requirement as-is. A few don't:
//
//   - `amazon-bedrock`: models.dev lists BOTH the SigV4 access-key pair
//     (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) AND the bearer-token var
//     (AWS_BEARER_TOKEN_BEDROCK) plus AWS_REGION — because the AWS SDK
//     supports both. Kortix's bedrock transport
//     (packages/llm-gateway/src/transports/bedrock/request.ts) authenticates
//     ONLY with the bearer token; the BYOK resolver
//     (apps/api/src/llm-gateway/resolution/resolve-candidates.ts +
//     models/provider-registry.ts) reads ONLY AWS_BEARER_TOKEN_BEDROCK +
//     AWS_REGION. SigV4 signing is unimplemented (explicit
//     TODO(bedrock-sigv4) in request.ts). Treating all 4 vars as one AND-of-
//     everything requirement made a fully-working Bedrock connection show as
//     "not connected" and made the connect form demand 2 dead fields.
//
//   - `google`: models.dev lists three ALIASES for the same single credential
//     (GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY — all
//     three are recognized interchangeably by @ai-sdk/google). Requiring all
//     three together (the old AND-of-`env` behavior) made Google
//     unconnectable through the modal — nobody sets three key aliases to the
//     same value. Any ONE of them is sufficient.
//
// Providers NOT listed in the override map below have exactly one
// implemented method, taken straight from the catalog's `env` — this map
// only holds CORRECTIONS, so it stays small, and every entry must cite the
// transport code that justifies it (grep-able so it doesn't silently rot).
//
// *** THE MODEL ***
// A provider's real requirement is one or more independent auth METHODS
// (`ProviderAuthRequirement.methods`); a provider is "connected" when ANY
// method's env vars are ALL present (`isProviderAuthSatisfied`). This is
// deliberately more general than a flat env-var list so a provider can gain
// a second method later (e.g. Bedrock SigV4) without breaking existing
// connections on the first one — see the amazon-bedrock entry's comment.
//
// *** WHO USES THIS ***
// The single source of truth for BOTH "what fields does the connect form
// ask for" (always `methods[0]`, via `primaryAuthEnvVars`) and "is this
// provider connected" (`isProviderAuthSatisfied` over the FULL requirement)
// — in the web provider modal (apps/web/src/lib/llm-providers.ts,
// apps/web/src/hooks/opencode/provider-selection.ts), the SDK's native-mode
// provider merge (packages/sdk/src/react/provider-selection.ts), and the CLI
// (apps/cli/src/commands/providers.ts). All three derive from this module so
// they can't drift from each other or from what the gateway/transports
// actually read.
//
// *** AUDIT (2026-07-17) ***
// Checked every catalog provider with more than one `env` var against
// `packages/llm-gateway/src/catalog/compatibility.ts` (providerKindForNpm)
// and `apps/api/src/llm-gateway/resolution/*`. Besides bedrock/google above:
// azure, azure-cognitive-services, cloudflare-ai-gateway,
// cloudflare-workers-ai, databricks, google-vertex,
// google-vertex-anthropic, neon, privatemode-ai, and snowflake-cortex all
// list multiple env vars that are genuinely DIFFERENT-PURPOSE fields of one
// method (e.g. Vertex's project + location + credentials path) — real AND
// requirements, not alias/extra-method lists — and none of them has a
// gateway BYOK transport at all yet (providerKindForNpm returns null), so
// they're only ever used in native mode, where every listed var is read
// directly by the upstream SDK. No mismatch there; no override needed.
//
// NOTE: deliberately inlined here (not a separate ./auth-requirements
// module) — this package publishes dist/ via `tsc` with
// moduleResolution:"Bundler" (see tsconfig.build.json), which does not emit
// the explicit .js extensions plain Node ESM needs on relative imports.
// Every other export in this package has always lived in this one file for
// the same reason; keep new code here too rather than reintroducing a
// cross-file import that only breaks post-publish (`bun test`/`tsc --noEmit`
// both resolve it fine in-repo, which is why this class of bug doesn't show
// up until the SDK's install-smoke test actually runs the published tarball).

export interface ProviderAuthMethod {
  /** Optional label, surfaced only if a provider ever exposes >1 method in the UI (none do today — the connect form always uses methods[0]). */
  label?: string;
  /** Every one of these project-secret env vars must be set for this method to count as satisfied. */
  envVars: string[];
}

export interface ProviderAuthRequirement {
  /**
   * One or more independent ways to authenticate. A provider is CONNECTED if
   * ANY method's envVars are all present — see `isProviderAuthSatisfied`.
   */
  methods: ProviderAuthMethod[];
}

interface CatalogProviderLike {
  id: string;
  env?: string[];
}

const PROVIDER_AUTH_REQUIREMENT_OVERRIDES: Record<string, ProviderAuthRequirement> = {
  'amazon-bedrock': {
    methods: [
      {
        label: 'Bearer token',
        // See the module doc comment above for the full trail. When SigV4
        // signing lands, ADD a second method here (e.g. `{ label: 'IAM
        // access key', envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
        // 'AWS_REGION'] }`) — do not replace this one; existing bearer-token
        // connections must keep working.
        envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
      },
    ],
  },
  google: {
    methods: [
      // GOOGLE_GENERATIVE_AI_API_KEY first: the name @ai-sdk/google's own
      // docs lead with, and what Kortix's CLI/UI have always written when
      // connecting Google — kept as the connect form's primary field.
      { envVars: ['GOOGLE_GENERATIVE_AI_API_KEY'] },
      { envVars: ['GOOGLE_API_KEY'] },
      { envVars: ['GEMINI_API_KEY'] },
    ],
  },
};

/**
 * The auth requirement Kortix actually enforces for a catalog provider.
 * Falls back to a single method requiring every var in `provider.env`
 * (unchanged behavior) unless an override above corrects it.
 */
export function providerAuthRequirement(provider: CatalogProviderLike): ProviderAuthRequirement {
  const override = PROVIDER_AUTH_REQUIREMENT_OVERRIDES[provider.id];
  if (override) return override;
  const env = provider.env ?? [];
  return { methods: env.length > 0 ? [{ envVars: env }] : [] };
}

/**
 * The env vars the connect form should collect for a provider — always the
 * first (primary) auth method. Every provider has exactly one usable method
 * today; this is the field list `ApiKeyConnectForm` renders and writes.
 */
export function primaryAuthEnvVars(provider: CatalogProviderLike): string[] {
  return providerAuthRequirement(provider).methods[0]?.envVars ?? [];
}

/**
 * True when at least one of the requirement's auth methods has every one of
 * its env vars present, per `hasEnvVar`. ANY-OF-methods, ALL-OF-vars-within-
 * a-method — the one predicate every "is this provider connected" check
 * (web connect modal, model-selector gating, native-mode provider merge, CLI
 * `providers ls`) should use instead of hand-rolling `envVars.every(...)`
 * over the raw catalog list.
 */
export function isProviderAuthSatisfied(
  requirement: ProviderAuthRequirement,
  hasEnvVar: (envVar: string) => boolean,
): boolean {
  return requirement.methods.some(
    (method) => method.envVars.length > 0 && method.envVars.every(hasEnvVar),
  );
}

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
  transport: 'bedrock' | 'openrouter';
  // models.dev id for live pricing — upstream ids don't always match the catalog.
  pricingRef: string;
  tier: 'flagship' | 'balanced' | 'fast';
  // Vision (image input). Curated explicitly: managed slugs don't all exist on
  // models.dev (z-ai≠zhipuai, qwen≠alibaba, dotted vs dashed Claude ids), so
  // unlike BYOK models these can't derive it from the generated catalog.
  vision: boolean;
  // Context/output token window. Lives here (same reason as `vision`: managed
  // slugs aren't reliably on models.dev) and is served verbatim so OpenCode can
  // size the conversation and fire auto-compaction. This is the CANONICAL home —
  // it used to be backfilled from a hardcoded table in the sandbox agent server.
  limit: { context: number; output: number };
  // OpenRouter request-level provider routing preferences (their `provider`
  // body field), for 'openrouter'-transport models only. Without this,
  // OpenRouter load-balances across every host serving the slug — including
  // low-uptime fp4 requantizations that stall mid-generation until OpenRouter
  // kills the stream with "Upstream idle timeout exceeded".
  openrouterProvider?: Record<string, unknown>;
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
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    upstreamModelId: 'us.anthropic.claude-opus-4-8',
    transport: 'bedrock',
    pricingRef: 'anthropic/claude-opus-4.8',
    tier: 'flagship',
    vision: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    upstreamModelId: 'us.anthropic.claude-sonnet-4-6',
    transport: 'bedrock',
    pricingRef: 'anthropic/claude-sonnet-4.6',
    tier: 'balanced',
    vision: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  {
    id: 'glm-5.2',
    name: 'GLM 5.2',
    upstreamModelId: 'z-ai/glm-5.2',
    transport: 'openrouter',
    pricingRef: 'z-ai/glm-5.2',
    tier: 'balanced',
    vision: false,
    limit: { context: 1_000_000, output: 131_072 },
    // Prefer Z.AI's first-party endpoint (99.9%+ uptime, native fp8). Fallbacks
    // stay enabled so an actual Z.AI outage still routes rather than failing.
    openrouterProvider: { order: ['z-ai'], allow_fallbacks: true },
  },
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    upstreamModelId: 'qwen/qwen3.7-max',
    transport: 'openrouter',
    pricingRef: 'qwen/qwen3.7-max',
    tier: 'balanced',
    vision: false,
    limit: { context: 1_048_576, output: 64_000 },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    upstreamModelId: 'deepseek/deepseek-v4-pro',
    transport: 'openrouter',
    pricingRef: 'deepseek/deepseek-v4-pro',
    tier: 'balanced',
    vision: false,
    limit: { context: 1_048_576, output: 64_000 },
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    upstreamModelId: 'deepseek/deepseek-v4-flash',
    transport: 'openrouter',
    pricingRef: 'deepseek/deepseek-v4-flash',
    tier: 'balanced',
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
  MANAGED_MODELS.find((m) => m.tier === 'flagship') ?? MANAGED_MODELS[0]
).id;

// ─── AUTO: managed model selection ──────────────────────────────────────────
// The catalog advertises a synthetic `auto` model presented to users as
// "automatically picks the cheapest, most efficient model for the task." When a
// request asks for it, the gateway resolves it to a concrete managed model and
// bills it as the resolved model.
//
// AUTO resolves to Codex GPT-5.6 Sol. The gateway's finite model-fallback policy
// then falls back to managed GLM 5.2 if Codex cannot serve the turn.
//
// AUTO is currently HIDDEN from the picker (see AUTO_MODEL_ENABLED): every session
// explicitly opts into a concrete model. The resolution path below stays fully
// intact — the sandbox still defaults `small_model`/headless sessions to `auto`,
// and a stale gateway caller asking for raw `auto` still resolves — so re-exposing
// the toggle is a one-line flip.
export const AUTO_MODEL_ID = 'auto';

// Whether AUTO is exposed in the model picker. Off for now: we want an explicit
// opt-in on which model to use, and will bring AUTO back later. The web app reads
// this through `featureFlags.enableAutoModel`, which can override it per-deploy via
// NEXT_PUBLIC_ENABLE_AUTO_MODEL. The server keeps serving + resolving `auto`
// regardless, so this only gates the UI.
export const AUTO_MODEL_ENABLED = false;

// The single "what to choose for auto" knob: a gateway wire model. It may be a
// managed bare id (`glm-5.2`) or a provider-qualified id (`codex/gpt-5.6-sol`).
export const AUTO_DEFAULT_MODEL_ID = 'codex/gpt-5.6-sol';

const AUTO_TARGET_MODEL = AUTO_DEFAULT_MODEL_ID;
const AUTO_VISION_MODEL = 'claude-sonnet-4.6'; // when the request has image content

function requestHasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (
      Array.isArray(content) &&
      content.some(
        (part) =>
          !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url',
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
 *
 * `opts.defaultModel` is the account/agent-configured default for the calling
 * principal (a concrete wire model, never `auto`). It takes precedence over the
 * platform text default, so `auto` resolves to what the account actually wants.
 * The vision override still applies: if the chosen target is a managed text-only
 * model and the request carries an image, swap to a vision-capable model so
 * attachments aren't silently dropped. A vision-capable or BYOK default is kept.
 */
export function pickAutoModel(
  model: string,
  body: Record<string, unknown>,
  opts?: { defaultModel?: string | null },
): string | null {
  if (model !== AUTO_MODEL_ID && model !== `kortix/${AUTO_MODEL_ID}`) return null;
  const target = opts?.defaultModel || AUTO_TARGET_MODEL;
  if (requestHasImage(body)) {
    const bareId = target.startsWith('kortix/') ? target.slice('kortix/'.length) : target;
    const managed = getManagedModel(bareId);
    if (managed && !managed.vision) return AUTO_VISION_MODEL;
  }
  return target;
}

export const MODEL_SELECTOR_PROVIDER_IDS = [
  'kortix',
  'opencode',
  'anthropic',
  'openai',
  'github-copilot',
  'google',
  'openrouter',
  'vercel',
] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'ChatGPT',
  google: 'Google',
  xai: 'xAI',
  moonshotai: 'Moonshot',
  'moonshotai-cn': 'Moonshot',
  opencode: 'OpenCode Zen',
  kortix: 'Kortix',
  firmware: 'Firmware',
  bedrock: 'AWS Bedrock',
  openrouter: 'OpenRouter',
  'github-copilot': 'GitHub Copilot',
  vercel: 'Vercel',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  cohere: 'Cohere',
  llama: 'Llama',
  huggingface: 'Hugging Face',
  cerebras: 'Cerebras',
  togetherai: 'Together AI',
  fireworks: 'Fireworks',
  deepinfra: 'DeepInfra',
  nvidia: 'NVIDIA',
  cloudflare: 'Cloudflare',
  azure: 'Azure',
  ollama: 'Ollama',
  perplexity: 'Perplexity',
  lmstudio: 'LM Studio',
  v0: 'v0',
  wandb: 'W&B',
  baseten: 'Baseten',
  minimax: 'Moonshot',
  'minimax-cn': 'Moonshot',
  siliconflow: 'SiliconFlow',
  'siliconflow-cn': 'SiliconFlow',
  zhipuai: 'ZhipuAI',
  'zhipuai-cn': 'ZhipuAI',
  'google-vertex': 'Google Vertex',
  'google-vertex-anthropic': 'Vertex Anthropic',
  'azure-cognitive-services': 'Azure Cognitive',
  'cloudflare-ai-gateway': 'Cloudflare Gateway',
  'github-models': 'GitHub Models',
  'ollama-cloud': 'Ollama Cloud',
  'kai Coding Plan': 'AI21',
  zaicodingplan: 'AI21',
  venice: 'Venice',
  upstage: 'Upstage',
  nebius: 'Nebius',
  vultr: 'Vultr',
  friendli: 'Friendli',
  poe: 'Poe',
  requesty: 'Requesty',
  'sap-ai-core': 'SAP AI Core',
  scaleway: 'Scaleway',
  inception: 'Inception',
  morph: 'Morph',
  abacus: 'Abacus',
  bailing: 'Bailing',
  chutes: 'Chutes',
  fastrouter: 'FastRouter',
  helicone: 'Helicone',
  iflowcn: 'iFlytek',
  inference: 'Inference',
  'io-net': 'IO.net',
  'kimi-for-coding': 'Kimi',
  lucidquery: 'LucidQuery',
  modelscope: 'ModelScope',
  'nano-gpt': 'NanoGPT',
  ovhcloud: 'OVHcloud',
  submodel: 'Submodel',
  synthetic: 'Synthetic',
  xiaomi: 'Xiaomi',
  zenmux: 'Zenmux',
};
