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
  bedrockModelId: string;
  openRouterModelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  tier: 'flagship' | 'balanced' | 'fast';
}

// Managed model ids are single-segment (no `provider/` prefix). They are served
// to opencode under the `kortix` provider, so opencode references them as
// `kortix/<id>` (e.g. `kortix/kortix-power`) and sends `<id>` as the wire model.
// A bare, slash-free id is what lets the gateway tell a managed request
// (`kortix-power` → Bedrock) apart from a BYOK one (`anthropic/claude-...` →
// the user's own key) without the two ever colliding.
export const MANAGED_MODELS: ManagedModel[] = [
  {
    id: 'kortix-power',
    name: 'Kortix Power',
    bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
    openRouterModelId: 'anthropic/claude-sonnet-4.6',
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
    tier: 'flagship',
  },
  {
    id: 'kortix-basic',
    name: 'Kortix Basic',
    bedrockModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    openRouterModelId: 'anthropic/claude-haiku-4.5',
    inputPerMillion: 1,
    outputPerMillion: 5,
    cachedInputPerMillion: 0.1,
    tier: 'fast',
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

export const MANAGED_FLAGSHIP_MODEL_ID =
  (MANAGED_MODELS.find((m) => m.tier === 'flagship') ?? MANAGED_MODELS[0]).id;

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
