/**
 * ProviderLogo — renders an LLM provider's logo (SVG) with a labeled fallback.
 * Mirrors apps/web's ProviderLogo (provider-branding.tsx).
 *
 * SVGs live at apps/mobile/assets/provider-icons/ and import as React components
 * via react-native-svg-transformer (configured in metro.config.js).
 */

import * as React from 'react';
import { View, Text } from 'react-native';
import { useColorScheme } from 'nativewind';

// SVG imports — direct so the bundler tree-shakes correctly.
import Anthropic from '@/assets/provider-icons/anthropic.svg';
import OpenAI from '@/assets/provider-icons/openai.svg';
import OpenCode from '@/assets/provider-icons/opencode.svg';
import GithubCopilot from '@/assets/provider-icons/github-copilot.svg';
import Google from '@/assets/provider-icons/google.svg';
import OpenRouter from '@/assets/provider-icons/openrouter.svg';
import Vercel from '@/assets/provider-icons/vercel.svg';
import Groq from '@/assets/provider-icons/groq.svg';
import XAI from '@/assets/provider-icons/xai.svg';
import AmazonBedrock from '@/assets/provider-icons/amazon-bedrock.svg';
import MoonshotAI from '@/assets/provider-icons/moonshotai.svg';
import MoonshotAICN from '@/assets/provider-icons/moonshotai-cn.svg';
import Deepseek from '@/assets/provider-icons/deepseek.svg';
import Mistral from '@/assets/provider-icons/mistral.svg';
import Cohere from '@/assets/provider-icons/cohere.svg';
import Llama from '@/assets/provider-icons/llama.svg';
import HuggingFace from '@/assets/provider-icons/huggingface.svg';
import Cerebras from '@/assets/provider-icons/cerebras.svg';
import TogetherAI from '@/assets/provider-icons/togetherai.svg';
import Fireworks from '@/assets/provider-icons/fireworks-ai.svg';
import DeepInfra from '@/assets/provider-icons/deepinfra.svg';
import Nvidia from '@/assets/provider-icons/nvidia.svg';
import Cloudflare from '@/assets/provider-icons/cloudflare-workers-ai.svg';
import Azure from '@/assets/provider-icons/azure.svg';
import OllamaCloud from '@/assets/provider-icons/ollama-cloud.svg';
import Perplexity from '@/assets/provider-icons/perplexity.svg';
import LMStudio from '@/assets/provider-icons/lmstudio.svg';
import V0 from '@/assets/provider-icons/v0.svg';
import Wandb from '@/assets/provider-icons/wandb.svg';
import Baseten from '@/assets/provider-icons/baseten.svg';
import GithubModels from '@/assets/provider-icons/github-models.svg';
import GoogleVertex from '@/assets/provider-icons/google-vertex.svg';
import GoogleVertexAnthropic from '@/assets/provider-icons/google-vertex-anthropic.svg';

type SvgComponent = React.ComponentType<{ width?: number; height?: number; color?: string }>;

const PROVIDER_ICON_MAP: Record<string, SvgComponent> = {
  anthropic: Anthropic,
  openai: OpenAI,
  opencode: OpenCode,
  'github-copilot': GithubCopilot,
  google: Google,
  openrouter: OpenRouter,
  vercel: Vercel,
  groq: Groq,
  xai: XAI,
  bedrock: AmazonBedrock,
  moonshotai: MoonshotAI,
  'moonshotai-cn': MoonshotAICN,
  deepseek: Deepseek,
  mistral: Mistral,
  cohere: Cohere,
  llama: Llama,
  huggingface: HuggingFace,
  cerebras: Cerebras,
  togetherai: TogetherAI,
  fireworks: Fireworks,
  deepinfra: DeepInfra,
  nvidia: Nvidia,
  cloudflare: Cloudflare,
  azure: Azure,
  ollama: OllamaCloud,
  perplexity: Perplexity,
  lmstudio: LMStudio,
  v0: V0,
  wandb: Wandb,
  baseten: Baseten,
  'github-models': GithubModels,
  'google-vertex': GoogleVertex,
  'google-vertex-anthropic': GoogleVertexAnthropic,
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  opencode: 'OpenCode Zen',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  openrouter: 'OpenRouter',
  vercel: 'Vercel',
  groq: 'Groq',
  xai: 'xAI',
  bedrock: 'AWS Bedrock',
  moonshotai: 'Moonshot',
  'moonshotai-cn': 'Moonshot',
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
};

function initialsFor(providerID: string, name?: string): string {
  const label = PROVIDER_LABELS[providerID];
  if (label) {
    const words = label.split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return label.slice(0, 2).toUpperCase();
  }
  const source = (name || providerID).replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join('') || providerID.slice(0, 2)).toUpperCase();
}

export interface ProviderLogoProps {
  providerID: string;
  name?: string;
  size?: number;
}

export function ProviderLogo({ providerID, name, size = 36 }: ProviderLogoProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const Icon = PROVIDER_ICON_MAP[providerID];

  // No background plate when an SVG is present — render the logo at the full
  // box size so it reads as an icon, not a tile. Initials fallback keeps the
  // soft tile so the letters have a backdrop.
  // All provider SVGs use `fill="currentColor"`, so passing `color` tints them
  // uniformly per theme — no more "DeepInfra invisible on dark" issue.
  if (Icon) {
    const tint = isDark ? '#F4F4F5' : '#18181B';
    return (
      <View
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon width={size} height={size} color={tint} />
      </View>
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          fontSize: Math.round(size * 0.32),
          fontFamily: 'Roobert-SemiBold',
          color: isDark ? '#E4E4E7' : '#52525B',
          letterSpacing: 0.5,
        }}
      >
        {initialsFor(providerID, name)}
      </Text>
    </View>
  );
}
