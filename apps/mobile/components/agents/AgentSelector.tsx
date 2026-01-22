import { Icon } from '@/components/ui/icon';
import { ChevronDown } from 'lucide-react-native';
import * as React from 'react';
import { Platform, TouchableOpacity, View } from 'react-native';
import { useAgent } from '@/contexts/AgentContext';
import { ModeLogo } from '@/components/models/ModeLogo';

// Android hit slop for better touch targets
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 10, bottom: 10, left: 10, right: 10 } : undefined;

/**
 * Helper to determine if a model ID is "advanced" (power) mode
 */
function isAdvancedModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return (
    modelId === 'kortix/power' ||
    modelId === 'kortix-power' ||
    modelId.includes('claude-sonnet-4-5') ||
    modelId.includes('sonnet')
  );
}

interface AgentSelectorProps {
  onPress?: () => void;
  compact?: boolean;
}

/**
 * AgentSelector - Shows Basic or Advanced mode toggle
 * 
 * Displays the current mode (Basic/Advanced) based on selected model.
 * Tapping opens the agent drawer where user can switch modes.
 */
export function AgentSelector({ onPress, compact = true }: AgentSelectorProps) {
  const { selectedModelId, isLoading, hasInitialized } = useAgent();

  // Show loading state until initialization is complete
  if (isLoading || !hasInitialized) {
    return (
      <View className="flex-row items-center gap-1.5 rounded-full px-3.5 py-2">
        <View className="w-16 h-4 bg-muted rounded animate-pulse" />
      </View>
    );
  }

  const isAdvanced = isAdvancedModel(selectedModelId);
  const mode = isAdvanced ? 'advanced' : 'basic';

  if (compact) {
    return (
      <TouchableOpacity
        onPress={onPress}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}
        hitSlop={ANDROID_HIT_SLOP}
        activeOpacity={0.7}
      >
        <ModeLogo mode={mode} height={10} />
        <Icon
          as={ChevronDown}
          size={9}
          className="text-foreground/60"
          strokeWidth={2}
        />
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 }}
      hitSlop={ANDROID_HIT_SLOP}
      activeOpacity={0.7}
    >
      <ModeLogo mode={mode} height={13} />
      <Icon
        as={ChevronDown}
        size={10}
        className="text-foreground/60"
        strokeWidth={2}
      />
    </TouchableOpacity>
  );
}
