'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';

export const POPULAR_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'github-copilot',
  'google',
  'openrouter',
  'vercel',
];

export const MODEL_SELECTOR_PROVIDER_IDS = [
  'kortix',
  'anthropic',
  'openai',
  'github-copilot',
  'google',
  'openrouter',
  'vercel',
];

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
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
  'inception': 'Inception',
  'morph': 'Morph',
  'abacus': 'Abacus',
  'bailing': 'Bailing',
  'chutes': 'Chutes',
  'fastrouter': 'FastRouter',
  'helicone': 'Helicone',
  'iflowcn': 'iFlytek',
  'inference': 'Inference',
  'io-net': 'IO.net',
  'kimi-for-coding': 'Kimi',
  'lucidquery': 'LucidQuery',
  'modelscope': 'ModelScope',
  'nano-gpt': 'NanoGPT',
  'ovhcloud': 'OVHcloud',
  'submodel': 'Submodel',
  'synthetic': 'Synthetic',
  'xiaomi': 'Xiaomi',
  'avian': 'Avian',
  'zenmux': 'Zenmux',
};

export const PROVIDER_HINTS: Record<string, string> = {
  anthropic: 'Pro/Max or API key',
  openai: 'Pro/Plus or API key',
  'github-copilot': 'Use existing subscription',
};

export const PROVIDER_NOTES: Record<string, string> = {
  opencode: 'One key for many hosted models',
  anthropic: 'Claude Pro/Max subscription or your own API key',
  openai: 'ChatGPT Pro/Plus subscription or your own API key',
  'github-copilot': 'Reuse your existing Copilot plan',
  google: 'Gemini models from Google AI Studio',
  openrouter: 'Route across many providers',
  avian: 'OpenAI-compatible API with DeepSeek, Kimi, GLM, and MiniMax models',
  vercel: 'Use Vercel AI Gateway credentials',
};

const PROVIDER_ICON_MAP: Record<string, { src?: string; fallback: string }> = {
  anthropic: { src: '/provider-icons/anthropic.svg', fallback: 'AN' },
  openai: { src: '/provider-icons/openai.svg', fallback: 'OA' },
  opencode: { src: '/provider-icons/opencode.svg', fallback: 'OC' },
  kortix: { src: '/kortix-symbol.svg', fallback: 'KX' },
  'github-copilot': { src: '/provider-icons/github-copilot.svg', fallback: 'GH' },
  google: { src: '/provider-icons/google.svg', fallback: 'GO' },
  openrouter: { src: '/provider-icons/openrouter.svg', fallback: 'OR' },
  vercel: { src: '/provider-icons/vercel.svg', fallback: 'VE' },
  groq: { src: '/provider-icons/groq.svg', fallback: 'GQ' },
  xai: { src: '/provider-icons/xai.svg', fallback: 'XA' },
  bedrock: { src: '/provider-icons/amazon-bedrock.svg', fallback: 'AW' },
  moonshotai: { src: '/provider-icons/moonshotai.svg', fallback: 'MS' },
  'moonshotai-cn': { src: '/provider-icons/moonshotai-cn.svg', fallback: 'MS' },
  deepseek: { src: '/provider-icons/deepseek.svg', fallback: 'DS' },
  mistral: { src: '/provider-icons/mistral.svg', fallback: 'MI' },
  cohere: { src: '/provider-icons/cohere.svg', fallback: 'CO' },
  llama: { src: '/provider-icons/llama.svg', fallback: 'LL' },
  huggingface: { src: '/provider-icons/huggingface.svg', fallback: 'HF' },
  cerebras: { src: '/provider-icons/cerebras.svg', fallback: 'CE' },
  togetherai: { src: '/provider-icons/togetherai.svg', fallback: 'TA' },
  fireworks: { src: '/provider-icons/fireworks-ai.svg', fallback: 'FW' },
  deepinfra: { src: '/provider-icons/deepinfra.svg', fallback: 'DI' },
  nvidia: { src: '/provider-icons/nvidia.svg', fallback: 'NV' },
  cloudflare: { src: '/provider-icons/cloudflare-workers-ai.svg', fallback: 'CF' },
  azure: { src: '/provider-icons/azure.svg', fallback: 'AZ' },
  ollama: { src: '/provider-icons/ollama-cloud.svg', fallback: 'OL' },
  perplexity: { src: '/provider-icons/perplexity.svg', fallback: 'PE' },
  lmstudio: { src: '/provider-icons/lmstudio.svg', fallback: 'LM' },
  v0: { src: '/provider-icons/v0.svg', fallback: 'V0' },
  wandb: { src: '/provider-icons/wandb.svg', fallback: 'WB' },
  avian: { src: '/provider-icons/avian.svg', fallback: 'AV' },
  baseten: { src: '/provider-icons/baseten.svg', fallback: 'BT' },
  // Add all other icons - they fallback to initials if not mapped
};

function initialsFor(providerID: string, name?: string) {
  const label = PROVIDER_LABELS[providerID];
  if (label) {
    const words = label.split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return label.slice(0, 2).toUpperCase();
  }
  const source = (name || providerID).replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join('') || providerID.slice(0, 2)).toUpperCase();
}

export function ProviderLogo({
  providerID,
  name,
  className,
  size = 'default',
}: {
  providerID: string;
  name?: string;
  className?: string;
  size?: 'small' | 'default' | 'large';
}) {
  const iconDef = PROVIDER_ICON_MAP[providerID];

  const sizeClasses = {
    small: 'size-7',
    default: 'size-9',
    large: 'size-11',
  };

  const iconSizes = {
    small: 14,
    default: 18,
    large: 22,
  };

  return (
    <span
      className={cn(
        'flex items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800 shrink-0',
        sizeClasses[size],
        className,
      )}
      aria-hidden="true"
    >
      {iconDef?.src ? (
        <Image
          src={iconDef.src}
          alt=""
          width={iconSizes[size]}
          height={iconSizes[size]}
          className="object-contain dark:invert"
        />
      ) : (
        <span className={cn(
          'font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300',
          size === 'small' ? 'text-[9px]' : size === 'large' ? 'text-xs' : 'text-[10px]'
        )}>
          {initialsFor(providerID, name)}
        </span>
      )}
    </span>
  );
}
