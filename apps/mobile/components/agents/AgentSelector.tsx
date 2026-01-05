import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronDown } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View, Platform, TouchableOpacity, Image } from 'react-native';
import { AgentAvatar } from './AgentAvatar';
import { useAgent } from '@/contexts/AgentContext';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { useColorScheme } from 'nativewind';

// Android hit slop for better touch targets
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 10, bottom: 10, left: 10, right: 10 } : undefined;

interface AgentSelectorProps {
  onPress?: () => void;
  compact?: boolean;
}

export function AgentSelector({ onPress, compact = true }: AgentSelectorProps) {
  const { getCurrentAgent, selectedModelId, isLoading, agents, hasInitialized, error } = useAgent();
  const agent = getCurrentAgent();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // All hooks must be called before any conditional returns to follow Rules of Hooks
  // For non-compact mode, determine if Basic or Advanced mode based on agent model
  const isBasicMode = React.useMemo(() => {
    if (!agent?.model) {
      // Fallback to agent metadata
      return agent?.metadata?.is_suna_default || false;
    }
    // List of basic (free) models
    const basicModels = ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet-20241022'];
    return basicModels.includes(agent.model);
  }, [agent]);

  const modeText = isBasicMode ? 'Basic' : 'Advanced';
  const modeImage = React.useMemo(() => {
    if (isBasicMode) {
      return isDark 
        ? require('@/assets/images/Basic-Agent-Dark.png')
        : require('@/assets/images/Basic-Agent.png');
    } else {
      return isDark 
        ? require('@/assets/images/Advanced-Agent-Dark.png')
        : require('@/assets/images/Advanced-Agent.png');
    }
  }, [isBasicMode, isDark]);

  // Show loading until initialization is complete
  // Don't wait for agents.length > 0 in case of errors
  if (isLoading || !hasInitialized) {
    return (
      <View className="flex-row items-center gap-1.5 rounded-full px-3.5 py-2 ">
        <View className="w-6 h-6 bg-muted rounded-full animate-pulse" />
        <Text className="text-muted-foreground text-sm font-roobert-medium">Loading...</Text>
      </View>
    );
  }

  // If initialization is complete but no agent (error or no agents), show select UI
  if (!agent) {
    return (
      <TouchableOpacity
        onPress={onPress}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 }}
        hitSlop={ANDROID_HIT_SLOP}
        activeOpacity={0.7}
      >
        <View className="w-6 h-6 bg-muted rounded-full items-center justify-center">
          <Text className="text-muted-foreground text-xs font-roobert-bold">?</Text>
        </View>
        <Text className="text-muted-foreground text-sm font-roobert-medium">
          {error ? 'Error loading' : 'Select Mode'}
        </Text>
        <Icon
          as={ChevronDown}
          size={13}
          className="text-foreground/60"
          strokeWidth={2}
        />
      </TouchableOpacity>
    );
  }

  if (compact) {
    return (
      <TouchableOpacity
        onPress={onPress}
        hitSlop={ANDROID_HIT_SLOP}
        activeOpacity={0.7}
      >
        <AgentAvatar agent={agent} size={26} />
        <View className="absolute -bottom-0.5 -right-0.5 rounded-full items-center justify-center" style={{ width: 13, height: 13 }}>
          <Icon
            as={ChevronDown}
            size={8}
            className="text-foreground"
            strokeWidth={2.5}
          />
        </View>
      </TouchableOpacity>
    );
  }

  // Non-compact mode: show as "Basic" or "Advanced" button with mode-specific image
  return (
    <TouchableOpacity
      onPress={onPress}
      className="h-10 rounded-2xl bg-input border border-border flex-row items-center gap-2 px-[10px]"
      hitSlop={ANDROID_HIT_SLOP}
      activeOpacity={0.7}
    >
      <View className="w-5 h-5 rounded-full overflow-hidden">
        <Image
          source={modeImage}
          style={{ width: 20, height: 20 }}
          resizeMode="cover"
        />
      </View>
      <Text className="text-foreground text-sm font-roobert-medium">{modeText}</Text>
    </TouchableOpacity>
  );
}

