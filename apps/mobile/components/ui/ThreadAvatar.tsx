import * as React from 'react';
import { Platform, type ViewProps } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import type { LucideIcon } from 'lucide-react-native';
import { getDrawerBackgroundColor } from '@agentpress/shared';
import { colorScheme, useColorScheme } from 'nativewind';

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
  const { colorScheme } = useColorScheme();
  return (
    <Avatar
      variant="thread"
      size={size}
      icon={icon}
      backgroundColor={backgroundColor}
      iconColor={iconColor || getDrawerBackgroundColor(Platform.OS, colorScheme)}
      fallbackText={title}
      style={style}
      {...props}
    />
  );
}

