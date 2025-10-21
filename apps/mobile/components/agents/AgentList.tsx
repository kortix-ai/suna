import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AgentAvatar } from './AgentAvatar';
import type { Agent } from '@/api/types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface AgentListProps {
  agents: Agent[];
  selectedAgentId?: string;
  onAgentPress?: (agent: Agent) => void;
  showChevron?: boolean;
  compact?: boolean;
}

/**
 * AgentList Component - Reusable agent list for both AgentDrawer and MenuPage
 * 
 * Features:
 * - Consistent agent selection UI
 * - Configurable compact/normal layout
 * - Optional chevron indicators
 * - Proper haptic feedback
 * - Accessibility support
 * - Spring animations
 */
export function AgentList({
  agents,
  selectedAgentId,
  onAgentPress,
  showChevron = false,
  compact = false
}: AgentListProps) {
  const handleAgentPress = React.useCallback((agent: Agent) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('🤖 Agent selected:', agent.name);
    console.log('📊 Agent data:', agent);
    onAgentPress?.(agent);
  }, [onAgentPress]);

  const containerGap = compact ? 'gap-2' : 'gap-3';
  const itemPadding = compact ? 'p-3' : 'py-3 px-3';
  const avatarSize = compact ? 36 : 40;

  return (
    <View className={containerGap}>
      {agents.map((agent) => {
        const isSelected = agent.agent_id === selectedAgentId;
        
        return (
          <AgentListItem
            key={agent.agent_id}
            agent={agent}
            isSelected={isSelected}
            onPress={handleAgentPress}
            showChevron={showChevron}
            compact={compact}
            avatarSize={avatarSize}
            itemPadding={itemPadding}
          />
        );
      })}
    </View>
  );
}

interface AgentListItemProps {
  agent: Agent;
  isSelected: boolean;
  onPress: (agent: Agent) => void;
  showChevron: boolean;
  compact: boolean;
  avatarSize: number;
  itemPadding: string;
}

function AgentListItem({
  agent,
  isSelected,
  onPress,
  showChevron,
  compact,
  avatarSize,
  itemPadding
}: AgentListItemProps) {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  return (
    <AnimatedPressable
      onPress={() => onPress(agent)}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className={`flex-row items-center ${itemPadding} rounded-xl active:opacity-70 ${
        isSelected ? 'bg-primary/10' : 'bg-transparent'
      }`}
      accessibilityRole="button"
      accessibilityLabel={`Select ${agent.name} worker`}
      accessibilityHint={`Opens chat with ${agent.name} AI assistant`}
    >
      <AgentAvatar agent={agent} size={avatarSize} />
      
      <View className={`${compact ? 'ml-3' : 'ml-3'} flex-1`}>
        <Text className={`text-base font-roobert-medium ${
          isSelected ? 'text-primary' : 'text-foreground'
        }`}>
          {agent.name}
        </Text>
      </View>
      
      {showChevron && (
        <Icon as={ChevronRight} size={18} className="text-foreground/50" />
      )}
      
      {!showChevron && isSelected && (
        <View className="w-2 h-2 rounded-full bg-primary" />
      )}
    </AnimatedPressable>
  );
}
