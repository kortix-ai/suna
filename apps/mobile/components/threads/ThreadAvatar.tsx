import * as React from 'react';
import { type ViewProps } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';

interface ThreadAvatarProps extends ViewProps {
  title?: string;
  size?: number;
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
export function ThreadAvatar({ title, size = 48, style, ...props }: ThreadAvatarProps) {
  return (
    <Avatar
      variant="thread"
      size={size}
      fallbackText={title}
      style={style}
      {...props}
    />
  );
}

