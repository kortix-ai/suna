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
import { KortixLogo } from '@/components/ui/KortixLogo';
import { useGuestMode } from '@/contexts';

interface AgentIdentifierProps extends ViewProps {
  agentId?: string | null;
  agent?: Agent;
  size?: number;
  showName?: boolean;
  textSize?: 'xs' | 'sm' | 'base';
}

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
  const { isGuestMode } = useGuestMode();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  console.log('[AgentIdentifier] isGuestMode:', isGuestMode, 'agentId:', agentId);
  
  const textSizeClass = {
    xs: 'text-xs',
    sm: 'text-sm',
    base: 'text-base',
  }[textSize];

  const agent = useMemo(() => {
    if (isGuestMode) {
      console.log('[AgentIdentifier] In guest mode, returning null agent');
      return null;
    }
    if (providedAgent) return providedAgent;
    if (agentId) {
      const found = agents.find(a => a.agent_id === agentId);
      if (found) return found;
    }
    const selectedAgent = agents.find(a => a.agent_id === selectedAgentId);
    return selectedAgent || agents[0] || null;
  }, [agentId, providedAgent, agents, selectedAgentId, isGuestMode]);

  if (isGuestMode) {
    console.log('[AgentIdentifier] Rendering guest mode view with Suna');
    return (
      <View 
        className="flex-row items-center gap-1.5"
        style={style}
        {...props}
      >
        <View className="rounded-md bg-primary items-center justify-center" style={{ width: size, height: size }}>
          <KortixLogo size={size * 0.55} variant="symbol" color={isDark ? 'light' : 'dark'} />
        </View>
        {showName && (
          <Text 
            className={`${textSizeClass} font-medium opacity-50`} 
            style={{ color: isDark ? '#f8f8f8' : '#121215' }}
          >
            Suna
          </Text>
        )}
      </View>
    );
  }

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

