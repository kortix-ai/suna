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
