/**
 * Agent List Component - Reusable agent list using generic ItemList
 * 
 * Features:
 * - Consistent agent selection UI
 * - Configurable compact/normal layout
 * - Optional chevron indicators
 * - Proper haptic feedback
 * - Accessibility support
 * - Spring animations
 */

import * as React from 'react';
import { View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { ListItem } from '@/components/shared/ListItem';
import { AgentAvatar } from './AgentAvatar';
import { Icon } from '@/components/ui/icon';
import type { Agent } from '@/api/types';

interface AgentListProps {
  agents: Agent[];
  selectedAgentId?: string;
  onAgentPress?: (agent: Agent) => void;
  showChevron?: boolean;
  compact?: boolean;
}

export function AgentList({
  agents,
  selectedAgentId,
  onAgentPress,
  showChevron = false,
  compact = false
}: AgentListProps) {
  const containerGap = compact ? 'gap-2' : 'gap-3';

  return (
    <View className={containerGap}>
      {agents.map((agent) => {
        const isSelected = agent.agent_id === selectedAgentId;
        
        // Custom icon element with AgentAvatar
        const iconElement = (
          <AgentAvatar agent={agent} size={compact ? 36 : 40} />
        );
        
        // Right-side indicator
        const rightIndicator = showChevron ? (
          <Icon as={ChevronRight} size={18} className="text-foreground/50" />
        ) : isSelected ? (
          <View className="w-2 h-2 rounded-full bg-primary" />
        ) : null;
        
        return (
          <ListItem
            key={agent.agent_id}
            iconElement={iconElement}
            title={agent.name}
            subtitle={agent.description}
            statusIndicator={rightIndicator}
            onPress={() => onAgentPress?.(agent)}
            isSelected={isSelected}
            accessibilityLabel={`Select ${agent.name} worker`}
            marginBottom={compact ? 8 : 12}
          />
        );
      })}
    </View>
  );
}
