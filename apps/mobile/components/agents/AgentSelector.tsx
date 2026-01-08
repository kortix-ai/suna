import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronDown } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View, Platform, TouchableOpacity } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import { AgentAvatar } from './AgentAvatar';
import { useAgent } from '@/contexts/AgentContext';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { useColorScheme } from 'nativewind';
import { isKortixDefaultAgent } from '@/lib/agents';

// NOTE: AnimatedPressable blocks touches on Android - use TouchableOpacity instead
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Android hit slop for better touch targets
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 10, bottom: 10, left: 10, right: 10 } : undefined;

interface AgentSelectorProps {
  onPress?: () => void;
  compact?: boolean;
}

export function AgentSelector({ onPress, compact = true }: AgentSelectorProps) {
  const { getCurrentAgent, isLoading, agents, hasInitialized, error } = useAgent();
  const agent = getCurrentAgent();
  const scale = useSharedValue(1);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

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
          {error ? 'Error loading' : 'Select Worker'}
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

  const isKortixDefault = isKortixDefaultAgent(agent);

  if (compact) {
    return (
      <TouchableOpacity
        onPress={onPress}
        hitSlop={ANDROID_HIT_SLOP}
        activeOpacity={0.7}
      >
        {isKortixDefault ? (
          <KortixLogo size={14} variant="symbol" color={isDark ? 'dark' : 'light'} />
        ) : (
        <AgentAvatar agent={agent} size={26} />
        )}
        <View className="absolute -bottom-1 -right-0.5 rounded-full items-center justify-center" style={{ width: 13, height: 13 }}>
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

  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 }}
      hitSlop={ANDROID_HIT_SLOP}
      activeOpacity={0.7}
    >
      {isKortixDefault ? (
        <KortixLogo size={11} variant="logomark" color={isDark ? 'dark' : 'light'} />
      ) : (
        <>
      <AgentAvatar agent={agent} size={19} />
      <Text className="text-foreground text-sm font-roobert-medium">{agent.name}</Text>
        </>
      )}
      <Icon
        as={ChevronDown}
        size={13}
        className="text-foreground/60"
        strokeWidth={2}
        style={{ marginTop: 2 }}
      />
    </TouchableOpacity>
  );
}

