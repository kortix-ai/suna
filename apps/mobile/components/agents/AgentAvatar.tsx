import { Icon } from '@/components/ui/icon';
import * as React from 'react';
import { View, type ViewProps } from 'react-native';
import { useColorScheme } from 'nativewind';
import { getIconFromName } from '@/lib/icon-mapping';
import type { Agent } from '@/api/types';

interface AgentAvatarProps extends ViewProps {
  agent?: Agent;
  size?: number;
}

/**
 * AgentAvatar Component - Consistent Design System
 * 
 * Features:
 * - Colored backgrounds per agent (from backend data)
 * - Icon colors contrasting with background
 * - Consistent rounded corners (16px for 48px containers)
 * - Subtle border (1.5px)
 * - All agents use the same design pattern
 * - Suna agent uses Lucide icon like others for consistency
 * 
 * Specifications:
 * - Default size: 40px × 40px
 * - Border radius: scales with size (30% of size)
 * - Border: 1.5px solid (dark: #232324, light: #DCDCDC)
 * - Icon: 50% of container size
 * - Colors: From backend icon_color and icon_background
 */
export function AgentAvatar({ agent, size = 40, style, ...props }: AgentAvatarProps) {
  const { colorScheme } = useColorScheme();
  
  const iconSize = Math.round(size * 0.5); // 50% of container size
  const borderRadius = Math.round(size * 0.3); // 30% for rounded look
  
  // Map backend icon name to Lucide icon
  const IconComponent = getIconFromName(agent?.icon_name);
  
  // Use backend colors or defaults
  const backgroundColor = agent?.icon_background || (colorScheme === 'dark' ? '#161618' : '#FFFFFF');
  const iconColor = agent?.icon_color || (colorScheme === 'dark' ? '#F8F8F8' : '#000000');
  const borderColor = colorScheme === 'dark' ? '#232324' : '#DCDCDC';

  return (
    <View 
      className="items-center justify-center"
      style={[
        { 
          width: size, 
          height: size,
          backgroundColor: backgroundColor,
          borderRadius: borderRadius,
          borderWidth: 1.5,
          borderColor: borderColor,
        },
        style
      ]}
      {...props}
    >
      <Icon 
        as={IconComponent} 
        size={iconSize} 
        color={iconColor}
        strokeWidth={2}
      />
    </View>
  );
}

