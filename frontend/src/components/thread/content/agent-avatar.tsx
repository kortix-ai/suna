'use client';

import React from 'react';
import { useAgentFromCache } from '@/hooks/agents/use-agents';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { DynamicIcon } from 'lucide-react/dynamic';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normalizeIconName } from '@/lib/utils/icon-utils';
import type { Agent } from '@/hooks/agents/utils';

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
  fallbackName = "Kortix",

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
  const iconColor = propIconColor ?? agent?.icon_color ?? '#6B7280';
  const backgroundColor = propBackgroundColor ?? agent?.icon_background ?? '#F3F4F6';
  const isSuna = propIsSunaDefault ?? agent?.metadata?.is_suna_default;

  // Calculate responsive border radius - proportional to size
  // Use a ratio that prevents full rounding while maintaining nice corners
  // For size 40, this gives 16px border radius (rounded-2xl)
  const borderRadius = Math.min(size * 0.4, 16);
  const borderRadiusStyle = {
    borderRadius: `${borderRadius}px` // 40% of size, max 16px (16px for size 40)
  };

  // Filter out any rounded-* classes from className to prevent overrides
  const filteredClassName = className
    .split(' ')
    .filter(cls => !cls.match(/^rounded(-[a-z0-9]+)?$/))
    .join(' ');

  // Show skeleton when no data is available
  if (!agent && !propIconName && !propIsSunaDefault && agentId) {
    return (
      <div
        className={cn("bg-muted animate-pulse", filteredClassName)}
        style={{ width: size, height: size, ...borderRadiusStyle }}
      />
    );
  }

  if (isSuna) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-card border",
          filteredClassName
        )}
        style={{ width: size, height: size, ...borderRadiusStyle }}
      >
        <KortixLogo size={size * 0.5} />
      </div>
    );
  }

  if (iconName) {
    // Normalize and validate the icon name
    const normalizedIconName = normalizeIconName(iconName);
    
    // If icon name is invalid, fall through to default bot icon
    if (normalizedIconName) {
      try {
        return (
          <div
            className={cn(
              "flex items-center justify-center transition-all border",
              filteredClassName
            )}
            style={{
              width: size,
              height: size,
              backgroundColor,
              ...borderRadiusStyle
            }}
          >
            <DynamicIcon
              name={normalizedIconName as any}
              size={size * 0.5}
              color={iconColor}
            />
          </div>
        );
      } catch (error) {
        // Fallback to default icon if DynamicIcon fails
        console.warn(`Invalid icon name: ${iconName}`, error);
      }
    }
  }

  // Fallback to default bot icon
  return (
    <div
      className={cn(
        "flex items-center justify-center bg-card border",
        filteredClassName
      )}
      style={{ width: size, height: size, ...borderRadiusStyle }}
    >
      <Bot
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
  fallback = "Kortix"
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