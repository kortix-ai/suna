'use client';

import { cn } from '../../lib/utils';
import {
  CATALOG_PROVIDER_ENV,
  MODEL_SELECTOR_PROVIDER_IDS as SHARED_MODEL_SELECTOR_PROVIDER_IDS,
  PROVIDER_LABELS as SHARED_PROVIDER_LABELS,
} from '@kortix/llm-catalog';
import { KortixLogo } from '../../primitives/kortix-logo';
import { useUiHostConfig, useUiImage } from '../../providers/ui-provider';
import { useState } from 'react';

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

/**
 * Provider id → icon file name. apps/web serves the files at `/provider-icons/<icon>.svg`
 * (`UiHostConfig.providerIconBaseUrl`); a host without them gets the models.dev logo of
 * the same name. `kortix` is drawn by `KortixLogo`, so the host's brand mark replaces it.
 */
const PROVIDER_ICON_MAP: Record<string, { icon: string; fallback: string }> = {
  anthropic: { icon: 'anthropic', fallback: 'AN' },
  openai: { icon: 'openai', fallback: 'OA' },
  codex: { icon: 'openai', fallback: 'GPT' },
  opencode: { icon: 'opencode', fallback: 'OC' },
  'opencode-go': { icon: 'opencode', fallback: 'OC' },
  'github-copilot': { icon: 'github-copilot', fallback: 'GH' },
  google: { icon: 'google', fallback: 'GO' },
  openrouter: { icon: 'openrouter', fallback: 'OR' },
  vercel: { icon: 'vercel', fallback: 'VE' },
  groq: { icon: 'groq', fallback: 'GQ' },
  xai: { icon: 'xai', fallback: 'XA' },
  // Bedrock: models.dev's canonical id is `amazon-bedrock`; keep the short
  // `bedrock` alias for any legacy call site that still passes it.
  'amazon-bedrock': { icon: 'amazon-bedrock', fallback: 'AW' },
  bedrock: { icon: 'amazon-bedrock', fallback: 'AW' },
  // Moonshot ships as three distinct providers on models.dev — Moonshot AI,
  // Moonshot AI (China), and the Kimi For Coding plan. They share the one
  // Moonshot mark (no separate -cn / kimi asset exists), but their VERBATIM
  // names keep them readable apart in the list.
  moonshotai: { icon: 'moonshotai', fallback: 'MS' },
  'moonshotai-cn': { icon: 'moonshotai', fallback: 'MS' },
  'kimi-for-coding': { icon: 'moonshotai', fallback: 'KI' },
  deepseek: { icon: 'deepseek', fallback: 'DS' },
  mistral: { icon: 'mistral', fallback: 'MI' },
  cohere: { icon: 'cohere', fallback: 'CO' },
  'cohere-platform': { icon: 'cohere', fallback: 'CO' },
  llama: { icon: 'llama', fallback: 'LL' },
  huggingface: { icon: 'huggingface', fallback: 'HF' },
  cerebras: { icon: 'cerebras', fallback: 'CE' },
  togetherai: { icon: 'togetherai', fallback: 'TA' },
  // Fireworks: `fireworks-ai` is the models.dev id; `firepass` is its
  // pass-through variant; keep `fireworks` as a legacy alias.
  'fireworks-ai': { icon: 'fireworks-ai', fallback: 'FW' },
  firepass: { icon: 'fireworks-ai', fallback: 'FW' },
  fireworks: { icon: 'fireworks-ai', fallback: 'FW' },
  deepinfra: { icon: 'deepinfra', fallback: 'DI' },
  nvidia: { icon: 'nvidia', fallback: 'NV' },
  // Google Vertex reuses the Google mark; the Anthropic-on-Vertex variant
  // reuses the Anthropic mark so it reads as what it actually serves.
  'google-vertex': { icon: 'google', fallback: 'GV' },
  'google-vertex-anthropic': { icon: 'anthropic', fallback: 'GV' },
  cloudflare: { icon: 'cloudflare-workers-ai', fallback: 'CF' },
  'cloudflare-workers-ai': { icon: 'cloudflare-workers-ai', fallback: 'CF' },
  azure: { icon: 'azure', fallback: 'AZ' },
  ollama: { icon: 'ollama-cloud', fallback: 'OL' },
  perplexity: { icon: 'perplexity', fallback: 'PE' },
  'perplexity-agent': { icon: 'perplexity', fallback: 'PE' },
  lmstudio: { icon: 'lmstudio', fallback: 'LM' },
  v0: { icon: 'v0', fallback: 'V0' },
  wandb: { icon: 'wandb', fallback: 'WB' },
  baseten: { icon: 'baseten', fallback: 'BT' },
  // Everything else falls back to monochrome initials.
};

const CATALOG_PROVIDER_IDS = new Set(CATALOG_PROVIDER_ENV.map((provider) => provider.id));

/**
 * Resolve a provider id to its logo, or `undefined` when there is none (the
 * caller falls back to monochrome initials). Keyed on the VERBATIM models.dev
 * provider ids so live-catalog entries resolve — see the icon-map notes above
 * for the Moonshot trio / Bedrock / Vertex cases. A mapped provider uses the
 * host's copy under `baseUrl` when the host serves one, else the models.dev
 * logo; a catalog provider without a mapped icon uses its models.dev logo.
 * models.dev answers any id with a generic mark, so an id outside the catalog
 * (a custom provider) keeps initials.
 */
export function providerIconSrc(providerID: string, baseUrl?: string): string | undefined {
  // Drawn in code (ProviderLogo), never fetched: models.dev has no Platinum logo
  // and answers with its generic sparkles mark.
  if (providerID === 'platinum') return undefined;
  const icon = PROVIDER_ICON_MAP[providerID]?.icon;
  if (icon) return baseUrl === undefined ? `https://models.dev/logos/${icon}.svg` : `${baseUrl}/${icon}.svg`;
  if (CATALOG_PROVIDER_IDS.has(providerID)) return `https://models.dev/logos/${providerID}.svg`;
  return undefined;
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
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0])
      .join('') || providerID.slice(0, 2)
  ).toUpperCase();
}

/** A third-party logo on a white tile with a hairline: black marks stay
 *  legible in both themes, so the tile never follows the theme. */
const LOGO_TILE_LIGHT = 'border-border rounded-md border bg-white';
const LOGO_TILE_LIGHT_TEXT = 'text-black';

/** The Kortix mark has no built-in padding, so it gets its own size per tile
 *  to match the other logos' optical size (roughly half the tile). In spacing
 *  steps (`size-3.5` … `size-5`), so the mark follows the host's `--spacing`. */
const KORTIX_MARK_STEPS = {
  xs: 3.5,
  small: 3,
  medium: 4,
  default: 4,
  large: 5,
} as const;

export function ProviderLogo({
  providerID,
  name,
  className,
  size = 'default',
  tone = 'theme',
}: {
  providerID: string;
  name?: string;
  className?: string;
  size?: 'xs' | 'small' | 'medium' | 'default' | 'large';
  /** `light`: a white tile with a hairline and the black mark in BOTH
   *  themes. `theme` follows the theme. */
  tone?: 'theme' | 'light';
}) {
  const Image = useUiImage();
  const { providerIconBaseUrl } = useUiHostConfig();
  const light = tone === 'light';
  // An unreachable models.dev logo (offline self-host) falls back to initials.
  const [failedSrc, setFailedSrc] = useState<string>();
  const kortix = providerID === 'kortix';
  const platinum = providerID === 'platinum';
  const iconSrc = kortix || platinum ? undefined : providerIconSrc(providerID, providerIconBaseUrl);
  const src = iconSrc === failedSrc ? undefined : iconSrc;

  const sizeClasses = {
    xs: 'size-4',
    small: 'size-8',
    medium: 'size-9',
    default: 'size-9',
    large: 'size-11',
  };

  const iconSizes = {
    xs: 16,
    small: 20,
    medium: 24,
    default: 22,
    large: 24,
  };

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center',
        // `xs` is the INLINE size — a bare mark sitting on a line of text (a
        // command-palette group heading), not a chip. The tile is what makes
        // the other sizes read as an avatar, and at 16px a tile around a 12px
        // mark is all frame and no logo. The initials fallback keeps its tile
        // at every size: two bare letters at 9px read as debris, not a logo.
        (src || kortix || platinum) && size === 'xs' ? 'bg-transparent' : light ? LOGO_TILE_LIGHT : 'bg-muted rounded-md',
        sizeClasses[size],
        className,
      )}
      aria-hidden="true"
    >
      {kortix ? (
        // The host's brand mark (`useBrand` icon), else the Kortix symbol in currentColor.
        <KortixLogo
          variant="icon"
          style={{
            width: `calc(var(--spacing) * ${KORTIX_MARK_STEPS[size]})`,
            height: `calc(var(--spacing) * ${KORTIX_MARK_STEPS[size]})`,
          }}
          className={light ? LOGO_TILE_LIGHT_TEXT : 'text-foreground'}
        />
      ) : platinum ? (
        // The Platinum mark (platinum.dev/brand): a flat square in currentColor,
        // the favicon geometry — 14 of 24, inset 5.
        <svg
          viewBox="0 0 24 24"
          style={{
            width: `calc(var(--spacing) * ${KORTIX_MARK_STEPS[size] + 2})`,
            height: `calc(var(--spacing) * ${KORTIX_MARK_STEPS[size] + 2})`,
          }}
          className={light ? LOGO_TILE_LIGHT_TEXT : 'text-foreground'}
        >
          <rect x="5" y="5" width="14" height="14" fill="currentColor" />
        </svg>
      ) : src ? (
        <Image
          src={src}
          alt=""
          width={iconSizes[size]}
          height={iconSizes[size]}
          unoptimized={src.startsWith('https:')}
          onError={() => setFailedSrc(src)}
          className={cn(
            'object-contain',
            !light && 'dark:invert',
          )}
        />
      ) : (
        <span
          className={cn(
            'font-semibold tracking-wide uppercase',
            light ? LOGO_TILE_LIGHT_TEXT : 'text-muted-foreground',
            size === 'xs' ? 'text-[9px]' : 'text-xs',
          )}
        >
          {initialsFor(providerID, name)}
        </span>
      )}
    </span>
  );
}
