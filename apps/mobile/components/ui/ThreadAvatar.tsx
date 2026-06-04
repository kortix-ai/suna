import * as React from 'react';
import { type ViewProps } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import type { LucideIcon } from 'lucide-react-native';

interface ThreadAvatarProps extends ViewProps {
  title?: string;
  size?: number;
  icon?: LucideIcon | string;
  backgroundColor?: string;
  iconColor?: string;
}

/**
 * ThreadAvatar Component - Thread/Chat-specific wrapper around unified Avatar
 * 
 * Uses the unified Avatar component with thread-specific configuration.
 * Uses MessageSquare icon by default.
 * 
 * @example
 * <ThreadAvatar title="My Chat" size={48} />
 */
export function ThreadAvatar({ 
  title, 
  size = 48, 
  icon,
  backgroundColor,
  iconColor,
  style, 
  ...props 
}: ThreadAvatarProps) {
  return (
    <Avatar
      variant="thread"
      size={size}
      icon={icon}
      backgroundColor={backgroundColor}
      iconColor={iconColor}
      fallbackText={title}
      style={style}
      {...props}
    />
  );
}

