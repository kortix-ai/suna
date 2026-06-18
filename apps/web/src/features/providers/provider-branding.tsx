'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  CATALOG,
  MODEL_SELECTOR_PROVIDER_IDS as SHARED_MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS as SHARED_PROVIDER_LABELS,
} from '@kortix/shared/llm-catalog';

export const POPULAR_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'github-copilot',
  'google',
  'openrouter',
  'vercel',
];

export const MODEL_SELECTOR_PROVIDER_IDS: readonly string[] = SHARED_MODEL_SELECTOR_PROVIDER_IDS;
export const PROVIDER_LABELS: Record<string, string> = SHARED_PROVIDER_LABELS;

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
  vercel: 'Use Vercel AI Gateway credentials',
};

const LOCAL_LOGOS: Record<string, string> = {
  kortix: '/kortix-symbol.svg',
};

function apexDomain(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

const PROVIDER_DOMAIN: Record<string, string> = {};
for (const provider of CATALOG.providers) {
  const url = provider.doc ?? provider.api ?? undefined;
  if (!url) continue;
  try {
    PROVIDER_DOMAIN[provider.id] = apexDomain(new URL(url).hostname);
  } catch {
    continue;
  }
}

function providerLogoSrc(providerID: string): string | undefined {
  if (LOCAL_LOGOS[providerID]) return LOCAL_LOGOS[providerID];
  const domain = PROVIDER_DOMAIN[providerID];
  return domain ? `https://icons.duckduckgo.com/ip3/${domain}.ico` : undefined;
}

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
  const [errored, setErrored] = useState(false);

  const tileSize = {
    small: 'size-7',
    default: 'size-9',
    large: 'size-11',
  };
  const imgSize = {
    small: 'size-4',
    default: 'size-5',
    large: 'size-6',
  };

  const src = providerLogoSrc(providerID);

  return (
    <span
      className={cn(
        'flex items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-black/[0.06] shrink-0',
        tileSize[size],
        className,
      )}
      aria-hidden="true"
    >
      {!src || errored ? (
        <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {initialsFor(providerID, name)}
        </span>
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
          className={cn('object-contain', imgSize[size])}
        />
      )}
    </span>
  );
}
