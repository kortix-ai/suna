import * as React from 'react';
import { type ViewProps } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import { getTriggerIcon } from '@/lib/utils/trigger-utils';
import type { TriggerWithAgent } from '@/api/types';

interface TriggerAvatarProps extends ViewProps {
  trigger?: TriggerWithAgent;
  size?: number;
}

/**
 * TriggerAvatar Component - Trigger-specific wrapper around unified Avatar
 * 
 * Uses the unified Avatar component with trigger-specific configuration.
 * Automatically selects icon based on trigger type using getTriggerIcon utility.
 * 
 * @example
 * <TriggerAvatar trigger={trigger} size={48} />
 */
export function TriggerAvatar({ trigger, size = 48, style, ...props }: TriggerAvatarProps) {
  const icon = trigger?.trigger_type ? getTriggerIcon(trigger.trigger_type) : undefined;
  
  return (
    <Avatar
      variant="trigger"
      size={size}
      icon={icon}
      fallbackText={trigger?.name}
      style={style}
      {...props}
    />
  );
}

