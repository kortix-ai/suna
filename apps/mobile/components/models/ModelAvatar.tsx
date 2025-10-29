import * as React from 'react';
import { View, type ViewProps } from 'react-native';
import { Cpu } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { getModelProviderIcon } from '@/lib/utils/model-provider';

interface ModelAvatarProps extends ViewProps {
  model?: any;
  size?: number;
}

/**
 * ModelAvatar Component - Model-specific avatar with provider icons
 * 
 * Displays the appropriate icon for each model provider (Anthropic, OpenAI, Google, etc.)
 * 
 * @example
 * <ModelAvatar model={model} size={48} />
 */
export function ModelAvatar({ model, size = 48, style, ...props }: ModelAvatarProps) {
  const { colorScheme } = useColorScheme();
  const modelId = model?.id || model?.model_id || '';
  
  // Get the icon component for this model
  const IconComponent = React.useMemo(() => {
    try {
      return getModelProviderIcon(modelId);
    } catch (error) {
      console.error('Error loading model icon:', error);
      return null;
    }
  }, [modelId]);
  
  // Calculate border radius (25% of size, max 16px)
  const borderRadius = Math.min(size * 0.25, 16);
  const iconSize = size * 0.6;
  
  // Icon fill color - white in dark mode, black in light mode
  const iconColor = colorScheme === 'dark' ? '#ffffff' : '#000000';
  
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: colorScheme === 'dark' ? '#27272a' : '#f4f4f5',
          borderWidth: 1,
          borderColor: colorScheme === 'dark' ? '#3f3f46' : '#e4e4e7',
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
      {...props}
    >
      {IconComponent ? (
        <IconComponent 
          width={iconSize} 
          height={iconSize}
          fill={iconColor}
          color={iconColor}
        />
      ) : (
        <Cpu 
          size={iconSize} 
          color={colorScheme === 'dark' ? '#e4e4e7' : '#71717a'} 
        />
      )}
    </View>
  );
}


