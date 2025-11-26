/**
 * AgentIdentifier Component
 * 
 * Displays agent avatar + name in a horizontal layout
 * Used in chat messages, tool cards, etc.
 * Uses AgentContext to get agent data
 * 
 * Memoized to prevent excessive re-renders
 */

import React, { useMemo } from 'react';
import { View, type ViewProps } from 'react-native';
import { Text } from '@/components/ui/text';
import { AgentAvatar } from './AgentAvatar';
import { useAgent } from '@/contexts/AgentContext';
import { useColorScheme } from 'nativewind';
import type { Agent } from '@/api/types';
import { KortixLogo } from '@/components/ui/KortixLogo';

interface AgentIdentifierProps extends ViewProps {
  agentId?: string | null;
  agent?: Agent;
  size?: number;
  showName?: boolean;
  textSize?: 'xs' | 'sm' | 'base';
}

function AgentIdentifierComponent({
  agentId,
  agent: providedAgent,
  size = 16,
  showName = true,
  textSize = 'xs',
  style,
  ...props
}: AgentIdentifierProps) {
  const { agents, selectedAgentId } = useAgent();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const textSizeClass = useMemo(() => {
    return {
      xs: 'text-xs',
      sm: 'text-sm',
      base: 'text-base',
    }[textSize];
  }, [textSize]);

  // Memoize agent lookup to avoid recalculation
  const agent = useMemo(() => {
    if (providedAgent) return providedAgent;
    if (agentId) {
      const found = agents.find(a => a.agent_id === agentId);
      if (found) return found;
    }
    const selectedAgent = agents.find(a => a.agent_id === selectedAgentId);
    return selectedAgent || agents[0] || null;
  }, [agentId, providedAgent, agents, selectedAgentId]);

  if (!agent) {
    return (
      <View 
        className="flex-row items-center gap-2"
        style={style}
        {...props}
      >
        <View className="w-6 h-6 bg-muted rounded-full animate-pulse" />
        {showName && (
          <View className="w-16 h-4 bg-muted rounded animate-pulse" />
        )}
      </View>
    );
  }

  return (
    <View 
      className="flex-row items-center gap-1.5"
      style={style}
      {...props}
    >
      <AgentAvatar agent={agent} size={size} />
      {showName && (
        <Text 
          className={`${textSizeClass} font-medium opacity-50`} 
          style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
        >
          {agent.name}
        </Text>
      )}
    </View>
  );
}

// Memoize component to prevent re-renders when props haven't changed
// Custom comparison function for better performance
export const AgentIdentifier = React.memo(AgentIdentifierComponent, (prevProps, nextProps) => {
  // Re-render if these props change
  if (
    prevProps.agentId !== nextProps.agentId ||
    prevProps.agent !== nextProps.agent ||
    prevProps.size !== nextProps.size ||
    prevProps.showName !== nextProps.showName ||
    prevProps.textSize !== nextProps.textSize
  ) {
    return false; // Props changed, allow re-render
  }
  
  // Check if style object changed (shallow comparison)
  if (prevProps.style !== nextProps.style) {
    return false;
  }
  
  // Props are the same, skip re-render
  return true;
});

