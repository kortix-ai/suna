/**
 * Model Provider Utilities
 * 
 * Utilities for determining model providers from model IDs
 */

import AnthropicIcon from '@/assets/images/models/Anthropic.svg';
import OAIIcon from '@/assets/images/models/OAI.svg';
import GeminiIcon from '@/assets/images/models/Gemini.svg';
import GrokIcon from '@/assets/images/models/Grok.svg';
import MoonshotIcon from '@/assets/images/models/Moonshot.svg';
import type { SvgProps } from 'react-native-svg';
import type React from 'react';

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

/**
 * Get the icon component for a model provider
 */
export function getModelProviderIcon(modelId: string): React.FC<SvgProps> {
  const provider = getModelProvider(modelId);
  
  const iconMap: Record<ModelProvider, React.FC<SvgProps>> = {
    anthropic: AnthropicIcon,
    openai: OAIIcon,
    google: GeminiIcon,
    xai: GrokIcon,
    moonshotai: MoonshotIcon,
    bedrock: AnthropicIcon, // Bedrock uses Anthropic models primarily
    openrouter: OAIIcon, // Default to OpenAI icon for OpenRouter
  };
  
  return iconMap[provider];
}

