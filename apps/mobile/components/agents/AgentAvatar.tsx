import * as React from 'react';
import { type ViewProps } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import type { Agent } from '@/api/types';

interface AgentAvatarProps extends ViewProps {
  agent?: Agent;
  size?: number;
}

/**
 * AgentAvatar Component - Agent-specific wrapper around unified Avatar
 * 
 * Uses the unified Avatar component with agent-specific configuration.
 * Automatically handles:
 * - Agent icon from backend (icon_name)
 * - Agent colors (icon_color, icon_background)
 * - SUNA/KORTIX SUPER WORKER special case (Kortix symbol)
 * - Fallback to agent name initial
 * 
 * @example
 * <AgentAvatar agent={agent} size={48} />
 */
export function AgentAvatar({ agent, size = 48, style, ...props }: AgentAvatarProps) {
  // Check if this is the SUNA/KORTIX SUPER WORKER
  const isSunaAgent = agent?.metadata?.is_suna_default || 
                      agent?.name?.toLowerCase() === 'suna' ||
                      agent?.name?.toLowerCase() === 'superworker' ||
                      agent?.name?.toLowerCase() === 'kortix super worker';

  return (
    <Avatar
      variant="agent"
      size={size}
      icon={agent?.icon_name || undefined}
      iconColor={isSunaAgent ? undefined : agent?.icon_color}
      backgroundColor={isSunaAgent ? undefined : agent?.icon_background}
      useKortixSymbol={isSunaAgent}
      fallbackText={agent?.name}
      style={style}
      {...props}
    />
  );
}

