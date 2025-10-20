/**
 * AgentIdentifier Component
 * 
 * Displays agent avatar + name in a horizontal layout
 * Used in chat messages, tool cards, etc.
 * Fetches agent data by agent_id with fallback to default
 */

import React, { useMemo } from 'react';
import { View, type ViewProps } from 'react-native';
import { Text } from '@/components/ui/text';
import { AgentAvatar } from './AgentAvatar';
import { getAgentById, DEFAULT_AGENT } from './agents';
import type { Agent } from '../shared/types';

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
 * <AgentIdentifier /> // Uses default agent
 * ```
 */
export function AgentIdentifier({
  agentId,
  agent: providedAgent,
  size = 24,
  showName = true,
  textSize = 'xs',
  style,
  ...props
}: AgentIdentifierProps) {
  // Get agent from ID or use provided agent or fallback to default
  const agent = useMemo(() => {
    if (providedAgent) return providedAgent;
    if (agentId) {
      const found = getAgentById(agentId);
      if (found) return found;
    }
    return DEFAULT_AGENT;
  }, [agentId, providedAgent]);

  const textSizeClass = {
    xs: 'text-xs',
    sm: 'text-sm',
    base: 'text-base',
  }[textSize];

  return (
    <View 
      className="flex-row items-center gap-2"
      style={style}
      {...props}
    >
      <AgentAvatar agent={agent} size={size} />
      {showName && (
        <Text className={`${textSizeClass} font-medium text-muted-foreground`}>
          {agent.name}
        </Text>
      )}
    </View>
  );
}

