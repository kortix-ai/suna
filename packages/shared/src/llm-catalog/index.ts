import catalogJson from './catalog.generated.json' with { type: 'json' };

interface CatalogModel {
  id: string;
  name: string;
  released?: string | null;
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
  // Bedrock invocation id (a cross-region inference-profile id like
  // `us.anthropic.claude-opus-4-8`, or a base model id like `deepseek.v3.2`).
  // Every managed model runs on Bedrock through our own credentials.
  bedrockModelId: string;
  // Which Bedrock transport carries it:
  //   'bedrock'          → Anthropic-on-Bedrock InvokeModel payload (Claude only)
  //   'bedrock-converse' → the model-agnostic Converse API (DeepSeek, Kimi, …)
  transport: 'bedrock' | 'bedrock-converse';
  // models.dev id for live pricing — Bedrock ids don't always match the catalog.
  pricingRef: string;
  tier: 'flagship' | 'balanced' | 'fast';
}

// Managed model ids are single-segment (no `provider/` prefix). They are served
// to opencode under the `kortix` provider, so opencode references them as
// `kortix/<id>` (e.g. `kortix/claude-opus-4.8`) and sends `<id>` as the wire
// model. A bare, slash-free id is what lets the gateway tell a managed request
// (`claude-opus-4.8` → our keys, credits-billed) apart from a BYOK one
// (`anthropic/claude-...` → the user's own key) without the two ever colliding.
//
// Bedrock-only: every managed model runs on AWS Bedrock through our own bearer
// key and is billed as Kortix credits with markup, so the gateway enforces
// budgets/logging/spend on all of them. Anthropic frontier uses the proven
// Anthropic-payload transport; DeepSeek/Kimi use the Converse transport.
// (OpenRouter was dropped — its per-provider availability, e.g. Kimi only on
// `novita`, made non-Anthropic models flaky; Qwen/GLM aren't on Bedrock at all.)
export const MANAGED_MODELS: ManagedModel[] = [
  {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    bedrockModelId: 'us.anthropic.claude-opus-4-8',
    transport: 'bedrock',
    pricingRef: 'anthropic/claude-opus-4.8',
    tier: 'flagship',
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
    transport: 'bedrock',
    pricingRef: 'anthropic/claude-sonnet-4.6',
    tier: 'balanced',
  },
  {
    id: 'deepseek-v3.2',
    name: 'DeepSeek V3.2',
    bedrockModelId: 'deepseek.v3.2',
    transport: 'bedrock-converse',
    pricingRef: 'deepseek/deepseek-v3.2',
    tier: 'balanced',
  },
  {
    id: 'kimi-k2',
    name: 'Kimi K2',
    bedrockModelId: 'moonshotai.kimi-k2.5',
    transport: 'bedrock-converse',
    pricingRef: 'moonshotai/kimi-k2',
    tier: 'balanced',
  },
];

const MANAGED_BY_ID = new Map(MANAGED_MODELS.map((m) => [m.id, m] as const));

// Back-compat: the gateway previously offered two branded ids. Stored agent
// configs / in-flight requests may still send them, so they keep resolving (to
// the nearest current model) even though they are no longer in the served
// catalog. Not advertised — absent from DEFAULT_MANAGED_MODEL_IDS.
const MANAGED_ALIASES: Record<string, string> = {
  'kortix-power': 'claude-sonnet-4.6',
  'kortix-basic': 'claude-sonnet-4.6',
};

export function getManagedModel(id: string): ManagedModel | undefined {
  return MANAGED_BY_ID.get(id) ?? MANAGED_BY_ID.get(MANAGED_ALIASES[id]);
}

export function isManagedModelId(id: string): boolean {
  return MANAGED_BY_ID.has(id) || id in MANAGED_ALIASES;
}

export const DEFAULT_MANAGED_MODEL_IDS = MANAGED_MODELS.map((m) => m.id);

export const MANAGED_FLAGSHIP_MODEL_ID = (
  MANAGED_MODELS.find((m) => m.tier === 'flagship') ?? MANAGED_MODELS[0]
).id;

export const MODEL_SELECTOR_PROVIDER_IDS = [
  'kortix-yolo',
  'kortix',
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
  'kortix-yolo': 'Kortix Yolo',
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
