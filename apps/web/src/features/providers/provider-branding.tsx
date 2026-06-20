'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';
import {
  MODEL_SELECTOR_PROVIDER_IDS as SHARED_MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS as SHARED_PROVIDER_LABELS,
} from '@kortix/shared/llm-catalog';

export const MODEL_SELECTOR_PROVIDER_IDS: readonly string[] = SHARED_MODEL_SELECTOR_PROVIDER_IDS;
export const PROVIDER_LABELS: Record<string, string> = SHARED_PROVIDER_LABELS;

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
  'moonshotai-cn': { src: '/provider-icons/moonshotai.svg', fallback: 'MS' },
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
  lmstudio: { src: '/provider-icons/generic-provider.svg', fallback: 'LM' },
  v0: { src: '/provider-icons/v0.svg', fallback: 'V0' },
  wandb: { src: '/provider-icons/generic-provider.svg', fallback: 'WB' },
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
          size === 'small' ? 'text-xs' : size === 'large' ? 'text-xs' : 'text-xs'
        )}>
          {initialsFor(providerID, name)}
        </span>
      )}
    </span>
  );
}
