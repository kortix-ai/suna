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
  // The Bedrock inference-profile id, when the model is reachable on Bedrock.
  // Only Anthropic models are — our Bedrock transport speaks the Anthropic-on-
  // Bedrock payload format — so non-Anthropic (Chinese) models omit this and are
  // served via OpenRouter instead. Absent here ⇒ no Bedrock candidate is built.
  bedrockModelId?: string;
  openRouterModelId: string;
  tier: 'flagship' | 'balanced' | 'fast';
}

// Managed model ids are single-segment (no `provider/` prefix). They are served
// to opencode under the `kortix` provider, so opencode references them as
// `kortix/<id>` (e.g. `kortix/claude-opus-4.8`) and sends `<id>` as the wire
// model. A bare, slash-free id is what lets the gateway tell a managed request
// (`claude-opus-4.8` → our keys, credits-billed) apart from a BYOK one
// (`anthropic/claude-...` → the user's own key) without the two ever colliding.
//
// Every managed model routes through our own provider keys and is billed as
// Kortix credits with markup, so the gateway enforces budgets/logging/spend on
// all of them. Anthropic frontier goes via Bedrock; the rest via OpenRouter.
export const MANAGED_MODELS: ManagedModel[] = [
  {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    bedrockModelId: 'us.anthropic.claude-opus-4-8',
    openRouterModelId: 'anthropic/claude-opus-4.8',
    tier: 'flagship',
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
    openRouterModelId: 'anthropic/claude-sonnet-4.6',
    tier: 'balanced',
  },
  {
    id: 'deepseek-v3.2',
    name: 'DeepSeek V3.2',
    openRouterModelId: 'deepseek/deepseek-v3.2',
    tier: 'balanced',
  },
  {
    id: 'qwen3-max',
    name: 'Qwen3 Max',
    openRouterModelId: 'qwen/qwen3-max',
    tier: 'balanced',
  },
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    openRouterModelId: 'z-ai/glm-4.6',
    tier: 'balanced',
  },
  {
    id: 'kimi-k2',
    name: 'Kimi K2',
    openRouterModelId: 'moonshotai/kimi-k2',
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
