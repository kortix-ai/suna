import * as React from 'react';
import { type ViewProps } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';

interface ModelAvatarProps extends ViewProps {
  model?: any;
  size?: number;
}

/**
 * ModelAvatar Component - Model-specific wrapper around unified Avatar
 * 
 * Uses the unified Avatar component with model-specific configuration.
 * Always uses the Layers icon for visual consistency.
 * 
 * @example
 * <ModelAvatar model={model} size={48} />
 */
export function ModelAvatar({ model, size = 48, style, ...props }: ModelAvatarProps) {
  return (
    <Avatar
      variant="model"
      size={size}
      fallbackText={model?.display_name || model?.name}
      style={style}
      {...props}
    />
  );
}


