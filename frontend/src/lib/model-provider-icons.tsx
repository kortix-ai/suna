import React from 'react';
import Image from 'next/image';
import { Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ModelProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'moonshotai'
  | 'bedrock'
  | 'openrouter'
  | 'kortix';

/**
 * Check if a model ID corresponds to a Kortix mode (Basic or POWER)
 */
export function isKortixMode(modelId: string): boolean {
  // New Kortix registry IDs
  if (modelId === 'kortix/basic' || modelId === 'kortix/power' || 
      modelId === 'kortix-basic' || modelId === 'kortix-power') {
    return true;
  }
  // Legacy: Kortix Basic (Haiku 4.5)
  if (modelId.includes('claude-haiku-4-5') || modelId.includes('heol2zyy5v48')) {
    return true;
  }
  // Legacy: Kortix POWER Mode (Sonnet 4.5)
  if (modelId.includes('claude-sonnet-4-5') || modelId.includes('few7z4l830xh')) {
    return true;
  }
  return false;
}

/**
 * Get the provider from a model ID
 */
export function getModelProvider(modelId: string): ModelProvider {
  // Check for Kortix modes first
  if (isKortixMode(modelId)) {
    return 'kortix';
  }
  if (modelId.includes('anthropic') || modelId.includes('claude')) {
    return 'anthropic';
  }
  if (modelId.includes('openai') || modelId.includes('gpt')) {
    return 'openai';
  }
  if (modelId.includes('google') || modelId.includes('gemini')) {
    return 'google';
  }
  if (modelId.includes('xai') || modelId.includes('grok')) {
    return 'xai';
  }
  if (modelId.includes('moonshotai') || modelId.includes('kimi')) {
    return 'moonshotai';
  }
  if (modelId.includes('bedrock')) {
    return 'bedrock';
  }
  if (modelId.includes('openrouter')) {
    return 'openrouter';
  }

  // Default fallback - try to extract provider from model ID format "provider/model"
  const parts = modelId.split('/');
  if (parts.length > 1) {
    const provider = parts[0].toLowerCase();
    if (['openai', 'anthropic', 'google', 'xai', 'moonshotai', 'bedrock', 'openrouter'].includes(provider)) {
      return provider as ModelProvider;
    }
  }

  return 'openai'; // Default fallback
}

/**
 * Component to render the model provider icon
 */
interface ModelProviderIconProps {
  modelId: string;
  size?: number;
  className?: string;
  variant?: 'default' | 'compact';
}

export function ModelProviderIcon({
  modelId,
  size = 24, // Default to 24px for better visibility
  className = '',
  variant = 'default'
}: ModelProviderIconProps) {
  const provider = getModelProvider(modelId);

  const iconMap: Record<ModelProvider, string> = {
    kortix: '/kortix-symbol.svg', // Kortix modes use the Kortix symbol
    anthropic: '/images/models/Anthropic.svg',
    openai: '/images/models/OAI.svg',
    google: '/images/models/Gemini.svg',
    xai: '/images/models/Grok.svg',
    moonshotai: '/images/models/Moonshot.svg',
    bedrock: '/images/models/Anthropic.svg', // Bedrock uses Anthropic models primarily
    openrouter: '/images/models/OAI.svg', // Default to OpenAI icon for OpenRouter
  };

  // Special handling for Kortix symbol - needs different invert behavior
  const isKortix = provider === 'kortix';

  const iconSrc = iconMap[provider];

  // Calculate responsive border radius - proportional to size (matching AgentAvatar)
  const borderRadiusStyle = {
    borderRadius: `${Math.min(size * 0.25, 16)}px` // 25% of size, max 16px
  };

  if (!iconSrc) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-card border flex-shrink-0",
          className
        )}
        style={{ width: size, height: size, ...borderRadiusStyle }}
      >
        <Cpu size={size * 0.6} className="text-muted-foreground dark:text-zinc-200" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-card border flex-shrink-0",
        className
      )}
      style={{ width: size, height: size, ...borderRadiusStyle }}
    >
      <Image
        src={iconSrc}
        alt={`${provider} icon`}
        width={size * 0.6} // Match agent avatar spacing
        height={size * 0.6}
        className={cn(
          "object-contain",
          // Kortix symbol: invert in dark mode (black symbol → white)
          // Other icons: invert in dark mode (black icons → white)
          isKortix ? "dark:invert" : "dark:brightness-0 dark:invert"
        )}
        style={{ width: size * 0.6, height: size * 0.6 }}
      />
    </div>
  );
}

/**
 * Get the provider display name
 */
export function getModelProviderName(modelId: string): string {
  const provider = getModelProvider(modelId);

  const nameMap: Record<ModelProvider, string> = {
    kortix: 'Kortix',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    xai: 'xAI',
    moonshotai: 'Moonshot AI',
    bedrock: 'AWS Bedrock',
    openrouter: 'OpenRouter',
  };

  return nameMap[provider] || 'Unknown';
}
