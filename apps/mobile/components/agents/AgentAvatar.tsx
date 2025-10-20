import { Icon } from '@/components/ui/icon';
import { Sparkles } from 'lucide-react-native';
import * as React from 'react';
import { View, type ViewProps } from 'react-native';
import { useColorScheme } from 'nativewind';
import KortixSymbol from '@/assets/brand/Symbol.svg';
import type { Agent } from '../shared/types';

interface AgentAvatarProps extends ViewProps {
  agent?: Agent;
  size?: number;
}

/**
 * AgentAvatar Component - Based on Figma Design
 * Node ID: 375-10160
 * 
 * Features:
 * - Colored backgrounds per agent (matching Figma)
 * - Icon colors contrasting with background
 * - Rounded corners (12px default, scales with size)
 * - Subtle border with shadow
 * - **Special handling for Super Worker (Kortix agent)**:
 *   - Uses Kortix Symbol.svg (theme-aware)
 *   - No background box
 *   - 20% smaller icon for elegance (same container size)
 * 
 * Specifications:
 * - Default size: 40px × 40px
 * - Border radius: 12px
 * - Border: 2px solid rgba(0,0,0,0.12)
 * - Icon: ~50% of container size
 * - Colors: Defined per agent in agents.ts
 * - Kortix agent: 80% icon size, no box, theme-aware symbol
 */
export function AgentAvatar({ agent, size = 40, style, ...props }: AgentAvatarProps) {
  const { colorScheme } = useColorScheme();
  
  // Special handling for Kortix agent (Super Worker)
  if (agent?.isKortixAgent) {
    const kortixSize = Math.round(size * 0.8); // 20% smaller for elegance
    
    return (
      <View 
        className="items-center justify-center"
        style={[
          { 
            width: size, // Keep container same size as other agents
            height: size,
          },
          style
        ]}
        {...props}
      >
        <KortixSymbol 
          width={kortixSize} 
          height={kortixSize}
          fill={colorScheme === 'dark' ? '#F8F8F8' : '#121215'}
        />
      </View>
    );
  }
  
  // Regular agent avatar
  const iconSize = Math.round(size * 0.5); // 50% of container size
  const borderRadius = Math.round(size * 0.3); // 30% for rounded look
  
  const IconComponent = agent?.icon || Sparkles;
  const backgroundColor = agent?.backgroundColor || '#161618'; // Default dark
  const iconColor = agent?.iconColor || '#F8F8F8'; // Default light

  return (
    <View 
      className="items-center justify-center"
      style={[
        { 
          width: size, 
          height: size,
          backgroundColor: backgroundColor,
          borderRadius: borderRadius,
          borderWidth: 2,
          borderColor: 'rgba(0, 0, 0, 0.12)',
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

