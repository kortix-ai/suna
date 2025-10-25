/**
 * AgentIdentifier Component
 * 
 * Displays agent avatar + name in a horizontal layout
 * Used in chat messages, tool cards, etc.
 * Uses AgentContext to get agent data
 */

import React, { useMemo } from 'react';
import { View, type ViewProps } from 'react-native';
import { Text } from '@/components/ui/text';
import { AgentAvatar } from './AgentAvatar';
import { useAgent } from '@/contexts/AgentContext';
import { useColorScheme } from 'nativewind';
import type { Agent } from '@/api/types';

interface AgentIdentifierProps extends ViewProps {
  /** Agent ID to fetch and display */
  agentId?: string | null;
  /** Direct agent object (bypasses lookup) */
  agent?: Agent;
  /** Avatar size in pixels */
  size?: number;
  /** Whether to show the agent name */
  showName?: boolean;
  /** Text size variant */
  textSize?: 'xs' | 'sm' | 'base';
}

/**
 * AgentIdentifier - Shows agent avatar with optional name
 * 
 * Usage:
 * ```tsx
 * <AgentIdentifier agentId="super-worker" size={24} showName />
 * <AgentIdentifier agent={myAgent} size={32} />
 * <AgentIdentifier /> // Uses current selected agent
 * ```
 */
export function AgentIdentifier({
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
  
  // Get agent from ID or use provided agent or fallback to current agent
  const agent = useMemo(() => {
    if (providedAgent) return providedAgent;
    if (agentId) {
      const found = agents.find(a => a.agent_id === agentId);
      if (found) return found;
    }
    // Fallback to selected agent
    const selectedAgent = agents.find(a => a.agent_id === selectedAgentId);
    return selectedAgent || agents[0] || null;
  }, [agentId, providedAgent, agents, selectedAgentId]);

  const textSizeClass = {
    xs: 'text-xs',
    sm: 'text-sm',
    base: 'text-base',
  }[textSize];

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

