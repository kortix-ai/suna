'use client';

import React from 'react';
import { useAgent } from '@/hooks/react-query/agents/use-agents';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { DynamicIcon } from 'lucide-react/dynamic';
import { cn } from '@/lib/utils';

interface AgentAvatarProps {
  // For fetching agent by ID
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
  // Agent fetch props
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
  const { data: agent, isLoading } = useAgent(agentId || '');

  // Determine values from props or agent data
  const iconName = propIconName ?? agent?.icon_name;
  const iconColor = propIconColor ?? agent?.icon_color ?? '#000000';
  const backgroundColor = propBackgroundColor ?? agent?.icon_background ?? '#F3F4F6';
  const agentName = propAgentName ?? agent?.name ?? fallbackName;
  const isSuna = propIsSunaDefault ?? agent?.metadata?.is_suna_default;

  if (isLoading && agentId) {
    return (
      <div 
        className={cn("bg-muted animate-pulse rounded-lg", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (!agent && !agentId && !propIconName && !propIsSunaDefault) {
    return (
      <div className={cn("flex items-center justify-center", className)}>
        <KortixLogo size={size} />
      </div>
    );
  }

  if (isSuna) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center rounded-lg bg-muted border",
          className
        )}
        style={{ width: size, height: size }}
      >
        <KortixLogo size={size * 0.6} />
      </div>
    );
  }

  if (iconName) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center rounded-lg transition-all",
          className
        )}
        style={{ 
          width: size, 
          height: size,
          backgroundColor
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
        "flex items-center justify-center rounded-lg bg-muted",
        className
      )}
      style={{ width: size, height: size }}
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
  agentId?: string;
  fallback?: string;
}

export const AgentName: React.FC<AgentNameProps> = ({ 
  agentId, 
  fallback = "Suna" 
}) => {
  const { data: agent, isLoading } = useAgent(agentId || '');

  if (isLoading && agentId) {
    return <span className="text-muted-foreground">Loading...</span>;
  }

  return <span>{agent?.name || fallback}</span>;
};

// Utility function for checking if agent has custom profile
export function hasCustomProfile(agent: {
  icon_name?: string | null;
}): boolean {
  return !!(agent.icon_name);
} 