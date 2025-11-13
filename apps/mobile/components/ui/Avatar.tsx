import { Icon } from '@/components/ui/icon';
import * as React from 'react';
import { View, type ViewProps, Text } from 'react-native';
import { useColorScheme } from 'nativewind';
import { getIconFromName } from '@/lib/utils/icon-mapping';
import { MessageSquare, Zap, Layers } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';

type AvatarVariant = 'agent' | 'model' | 'thread' | 'trigger' | 'custom';

interface AvatarProps extends ViewProps {
  /** Type of avatar to display */
  variant?: AvatarVariant;
  
  /** Size of the avatar container (default: 48) */
  size?: number;
  
  /** Icon to display (Lucide icon component or icon name string) */
  icon?: LucideIcon | string;
  
  /** Icon color (overrides defaults) */
  iconColor?: string;
  
  /** Background color (overrides defaults) */
  backgroundColor?: string;
  
  /** Border color (overrides defaults) */
  borderColor?: string;
  
  /** Show border (default: true) */
  showBorder?: boolean;
  
  /** Use Kortix symbol instead of icon (for SUNA agent) */
  useKortixSymbol?: boolean;
  
  /** Fallback text (first letter shown if no icon) */
  fallbackText?: string;
}

/**
 * Avatar Component - Unified avatar for all entity types
 * 
 * A single, consistent avatar component used across the entire app for:
 * - Agents (workers)
 * - Models (AI models)
 * - Threads (conversations)
 * - Triggers (automation)
 * - Custom use cases
 * 
 * Design Specifications:
 * - Default size: 48px × 48px
 * - Border radius: 16px (33.3% of size) - matches Figma
 * - Icon size: 40% of container (smaller than before for better spacing)
 * - Kortix symbol: 50% of container (larger for brand recognition)
 * - Border: 1.5px solid
 * - Adapts to dark/light theme
 * 
 * @example
 * // Agent avatar
 * <Avatar variant="agent" icon="Briefcase" backgroundColor="#161618" iconColor="#f8f8f8" />
 * 
 * // Model avatar
 * <Avatar variant="model" size={32} />
 * 
 * // Thread avatar
 * <Avatar variant="thread" fallbackText="AI Chat" />
 * 
 * // Custom avatar
 * <Avatar variant="custom" icon={CustomIcon} backgroundColor="#ff0000" />
 */
export function Avatar({
  variant = 'custom',
  size = 48,
  icon,
  iconColor,
  backgroundColor,
  borderColor,
  showBorder = true,
  useKortixSymbol = false,
  fallbackText,
  style,
  ...props
}: AvatarProps) {
  const { colorScheme } = useColorScheme();
  
  // Calculate sizes - optimized for minimalist design
  const iconSize = Math.round(size * 0.45); // 45% of container for better visibility
  const symbolSize = Math.round(size * 0.55); // 55% for Kortix symbol (more prominent)
  const borderRadius = Math.round(size * 0.32); // 32% for slightly softer corners
  
  // Get default colors based on variant and theme
  const getDefaultColors = () => {
    const isDark = colorScheme === 'dark';
    
    // Kortix symbol always uses solid black bg with white icon
    if (useKortixSymbol) {
      return {
        bg: '#000000',
        icon: '#FFFFFF',
        border: isDark ? '#2a2a2c' : '#d0d0d0',
      };
    }
    
    // Unified minimalist colors for all variants
    return {
      bg: isDark ? '#1a1a1c' : '#fafafa',
      icon: isDark ? '#f8f8f8' : '#121215',
      border: isDark ? '#2a2a2c' : '#e0e0e0',
    };
  };
  
  const defaults = getDefaultColors();
  const finalBg = backgroundColor || defaults.bg;
  const finalIconColor = iconColor || defaults.icon;
  const finalBorderColor = borderColor || defaults.border;
  
  // Get icon component
  const getIconComponent = (): LucideIcon | null => {
    if (!icon) {
      // Default icons based on variant
      switch (variant) {
        case 'model': return Layers;
        case 'thread': return MessageSquare;
        case 'trigger': return Zap;
        default: return null;
      }
    }
    
    if (typeof icon === 'string') {
      return getIconFromName(icon);
    }
    
    return icon;
  };
  
  const IconComponent = getIconComponent();
  const KortixSymbol = colorScheme === 'dark' ? KortixSymbolWhite : KortixSymbolBlack;

  return (
    <View 
      className="items-center justify-center"
      style={[
        { 
          width: size, 
          height: size,
          backgroundColor: finalBg,
          borderRadius: borderRadius,
          borderWidth: showBorder ? 1.5 : 0,
          borderColor: finalBorderColor,
        },
        style
      ]}
      {...props}
    >
      {useKortixSymbol ? (
        <KortixSymbol 
          width={symbolSize} 
          height={symbolSize}
        />
      ) : IconComponent ? (
        <Icon 
          as={IconComponent} 
          size={iconSize} 
          color={finalIconColor}
          strokeWidth={2.5}
        />
      ) : fallbackText ? (
        <Text 
          style={{ 
            color: finalIconColor,
            fontSize: size * 0.4,
            fontWeight: '600'
          }}
        >
          {fallbackText.charAt(0).toUpperCase()}
        </Text>
      ) : null}
    </View>
  );
}

