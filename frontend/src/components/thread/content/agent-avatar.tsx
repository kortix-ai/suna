'use client';

import React from 'react';
import { useAgentFromCache } from '@/hooks/react-query/agents/use-agents';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { DynamicIcon } from 'lucide-react/dynamic';
import { cn } from '@/lib/utils';
import type { Agent } from '@/hooks/react-query/agents/utils';

interface AgentAvatarProps {
  // For passing agent data directly (preferred - no fetch)
  agent?: Agent;
  
  // For fetching agent by ID (will use cache if available)
  agentId?: string;
  fallbackName?: string;
  
  // For direct props (bypasses agent fetch)
  iconName?: string | null;
  iconColor?: string;
  backgroundColor?: string;
  agentName?: string;
  isSunaDefault?: boolean;
  
  // Common props
  size?: number;
  className?: string;
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({ 
  // Agent data props
  agent: propAgent,
  agentId, 
  fallbackName = "Suna",
  
  // Direct props
  iconName: propIconName,
  iconColor: propIconColor,
  backgroundColor: propBackgroundColor,
  agentName: propAgentName,
  isSunaDefault: propIsSunaDefault,
  
  // Common props
  size = 16, 
  className = ""
}) => {
  // Try to get agent from cache if agentId is provided and agent prop is not
  const cachedAgent = useAgentFromCache(!propAgent && agentId ? agentId : undefined);
  const agent = propAgent || cachedAgent;

  // Determine values from props or agent data
  const iconName = propIconName ?? agent?.icon_name;
  const iconColor = propIconColor ?? agent?.icon_color ?? '#000000';
  const backgroundColor = propBackgroundColor ?? agent?.icon_background ?? '#F3F4F6';
  const agentName = propAgentName ?? agent?.name ?? fallbackName;
  const isSuna = propIsSunaDefault ?? agent?.metadata?.is_suna_default;

  // Calculate responsive border radius - proportional to size
  // Use a ratio that prevents full rounding while maintaining nice corners
  const borderRadiusStyle = {
    borderRadius: `${Math.min(size * 0.25, 16)}px` // 25% of size, max 16px
  };

  // Show skeleton when no data is available
  if (!agent && !propIconName && !propIsSunaDefault && agentId) {
    return (
      <div 
        className={cn("bg-muted animate-pulse border", className)}
        style={{ width: size, height: size, ...borderRadiusStyle }}
      />
    );
  }

  if (isSuna) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center bg-muted border",
          className
        )}
        style={{ width: size, height: size, ...borderRadiusStyle }}
      >
        <KortixLogo size={size * 0.6} />
      </div>
    );
  }

  if (iconName) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center transition-all border",
          className
        )}
        style={{ 
          width: size, 
          height: size,
          backgroundColor,
          ...borderRadiusStyle
        }}
      >
        <DynamicIcon 
          name={iconName as any} 
          size={size * 0.5} 
          color={iconColor}
        />
      </div>
    );
  }

  // Fallback to default bot icon
  return (
    <div 
      className={cn(
        "flex items-center justify-center bg-muted border",
        className
      )}
      style={{ width: size, height: size, ...borderRadiusStyle }}
    >
      <DynamicIcon 
        name="bot" 
        size={size * 0.5} 
        color="#6B7280"
      />
    </div>
  );
};

interface AgentNameProps {
  agent?: Agent;
  agentId?: string;
  fallback?: string;
}

export const AgentName: React.FC<AgentNameProps> = ({ 
  agent: propAgent,
  agentId, 
  fallback = "Suna" 
}) => {
  const cachedAgent = useAgentFromCache(!propAgent && agentId ? agentId : undefined);
  const agent = propAgent || cachedAgent;

  return <span>{agent?.name || fallback}</span>;
};

// Utility function for checking if agent has custom profile
export function hasCustomProfile(agent: {
  icon_name?: string | null;
}): boolean {
  return !!(agent.icon_name);
} 