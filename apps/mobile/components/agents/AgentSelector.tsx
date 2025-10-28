import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronDown } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { AgentAvatar } from './AgentAvatar';
import { useAgent } from '@/contexts/AgentContext';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface AgentSelectorProps {
  onPress?: () => void;
  compact?: boolean;
}

/**
 * AgentSelector Component
 * Displays current agent with avatar and name, opens drawer on press
 * 
 * Compact mode: Shows only avatar with small chevron overlay (minimal space)
 * Full mode: Shows avatar, name, and chevron (default)
 */
export function AgentSelector({ onPress, compact = true }: AgentSelectorProps) {
  const { getCurrentAgent, isLoading, agents } = useAgent();
  const agent = getCurrentAgent();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Show loading state only if agents are actually loading
  if (isLoading || agents.length === 0) {
    return (
      <View className="flex-row items-center gap-1.5 bg-secondary/50 rounded-full px-3.5 py-2 border border-border/30">
        <View className="w-6 h-6 bg-muted rounded-full animate-pulse" />
        <Text className="text-muted-foreground text-sm font-roobert-medium">Loading...</Text>
      </View>
    );
  }

  // Show "Select Agent" if agents are loaded but none selected
  if (!agent) {
    return (
      <AnimatedPressable 
        onPressIn={() => {
          scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        onPress={onPress}
        className="flex-row items-center gap-1.5 bg-secondary/50 rounded-full px-3.5 py-2 border border-border/30"
        style={animatedStyle}
      >
        <View className="w-6 h-6 bg-muted rounded-full items-center justify-center">
          <Text className="text-muted-foreground text-xs font-roobert-bold">?</Text>
        </View>
        <Text className="text-muted-foreground text-sm font-roobert-medium">Select Agent</Text>
        <Icon 
          as={ChevronDown} 
          size={13} 
          className="text-foreground/60"
          strokeWidth={2}
        />
      </AnimatedPressable>
    );
  }

  if (compact) {
    // Minimal version: just avatar with chevron badge
    return (
      <AnimatedPressable 
        onPressIn={() => {
          scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        onPress={onPress}
        className="relative"
        style={animatedStyle}
      >
        <AgentAvatar agent={agent} size={26} />
        {/* Small chevron indicator */}
        <View className="absolute -bottom-0.5 -right-0.5 bg-secondary rounded-full items-center justify-center" style={{ width: 13, height: 13 }}>
          <Icon 
            as={ChevronDown} 
            size={8} 
            className="text-foreground"
            strokeWidth={2.5}
          />
        </View>
      </AnimatedPressable>
    );
  }

  // Full version with name
  return (
    <AnimatedPressable 
      onPressIn={() => {
        scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={onPress}
      className="flex-row items-center gap-1.5 bg-secondary/50 rounded-full px-3.5 py-2 border border-border/30"
      style={animatedStyle}
    >
      {/* Agent info with avatar */}
      <AgentAvatar agent={agent} size={19} />
      <Text className="text-foreground text-sm font-roobert-medium">{agent.name}</Text>
      
      {/* Chevron down */}
      <Icon 
        as={ChevronDown} 
        size={13} 
        className="text-foreground/60"
        strokeWidth={2}
      />
    </AnimatedPressable>
  );
}

