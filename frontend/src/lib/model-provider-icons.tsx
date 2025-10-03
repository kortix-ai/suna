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
  | 'openrouter';

/**
 * Get the provider from a model ID
 */
export function getModelProvider(modelId: string): ModelProvider {
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
    anthropic: '/images/models/Anthropic.svg',
    openai: '/images/models/OAI.svg',
    google: '/images/models/Gemini.svg',
    xai: '/images/models/Grok.svg',
    moonshotai: '/images/models/Moonshot.svg',
    bedrock: '/images/models/Anthropic.svg', // Bedrock uses Anthropic models primarily
    openrouter: '/images/models/OAI.svg', // Default to OpenAI icon for OpenRouter
  };

  const iconSrc = iconMap[provider];

  // Calculate responsive border radius - proportional to size (matching AgentAvatar)
  const borderRadiusStyle = {
    borderRadius: `${Math.min(size * 0.25, 16)}px` // 25% of size, max 16px
  };

  if (!iconSrc) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center bg-muted dark:bg-zinc-800 border dark:border-zinc-700 flex-shrink-0",
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
        "flex items-center justify-center bg-background dark:bg-zinc-800 border dark:border-zinc-700 flex-shrink-0",
        className
      )}
      style={{ width: size, height: size, ...borderRadiusStyle }}
    >
      <Image
        src={iconSrc}
        alt={`${provider} icon`}
        width={size * 0.6} // Match agent avatar spacing
        height={size * 0.6}
        className="object-contain dark:brightness-0 dark:invert"
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
