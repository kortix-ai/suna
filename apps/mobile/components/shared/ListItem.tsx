/**
 * Generic ListItem Component
 * 
 * Reusable list item for conversations, agents, triggers, and more.
 * 
 * Design Specifications:
 * - Compact design: 48px min-height
 * - Icon container: 48x48px, 16px border-radius, 1.5px border
 * - Icon size: 20px
 * - Gap between icon and content: 10px (gap-2.5)
 * - Light Mode: White bg (#FFFFFF), #DCDCDC border, black icon/text
 * - Dark Mode: #161618 bg, #232324 border, white icon/text
 * - Typography: Roobert-Medium 16px (title), Roobert 14px/12px (subtitle/meta)
 * - Press animation: Scale to 0.97
 */

import React, { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import type { LucideIcon } from 'lucide-react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface ListItemProps {
  /** Icon component from lucide-react-native */
  icon?: LucideIcon;
  /** Custom icon element (takes precedence over icon prop) */
  iconElement?: ReactNode;
  /** Main title text */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Optional metadata (e.g., date, status) shown on the right */
  meta?: string | ReactNode;
  /** Optional status indicator (e.g., active/inactive dot) */
  statusIndicator?: ReactNode;
  /** Handler for press events */
  onPress?: () => void;
  /** Whether the item is selected/active */
  isSelected?: boolean;
  /** Additional className for customization */
  className?: string;
  /** Accessibility label */
  accessibilityLabel?: string;
  /** Additional spacing at the bottom */
  marginBottom?: number;
}

export function ListItem({
  icon,
  iconElement,
  title,
  subtitle,
  meta,
  statusIndicator,
  onPress,
  isSelected = false,
  className = '',
  accessibilityLabel,
  marginBottom = 3,
}: ListItemProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  // Animated style for press feedback
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.();
  };

  // Icon container styles - Exact colors from design system
  const iconContainerStyles = colorScheme === 'dark'
    ? 'bg-[#161618] border-[#232324]'
    : 'bg-white border-[#DCDCDC]';
  
  const iconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const textColor = colorScheme === 'dark' ? 'text-white' : 'text-black';
  const selectedBg = isSelected 
    ? (colorScheme === 'dark' ? 'bg-primary/10' : 'bg-primary/5')
    : '';

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[animatedStyle, { marginBottom }]}
      className={`flex-row items-center gap-2.5 w-full ${selectedBg} ${className}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || `Open ${title}`}
    >
      {/* Icon Container - 48x48px compact design */}
      <View 
        className={`${iconContainerStyles} rounded-2xl items-center justify-center border-[1.5px]`}
        style={{ width: 48, height: 48 }}
      >
        {iconElement ? (
          iconElement
        ) : icon ? (
          <Icon as={icon} size={20} color={iconColor} />
        ) : null}
      </View>
      
      {/* Content Section - Compact spacing */}
      <View className="flex-1 gap-2 justify-center" style={{ minHeight: 48 }}>
        {/* Title & Meta Row */}
        <View className="flex-row items-center justify-between gap-3">
          <Text 
            className={`text-base font-roobert-medium ${textColor} flex-1`} 
            numberOfLines={1}
          >
            {title}
          </Text>
          
          {/* Right-side meta content */}
          {(meta || statusIndicator) && (
            <View className="flex-row items-center gap-2">
              {statusIndicator}
              {typeof meta === 'string' ? (
                <Text className={`text-xs font-roobert-medium ${textColor} opacity-50`}>
                  {meta}
                </Text>
              ) : (
                meta
              )}
            </View>
          )}
        </View>
        
        {/* Optional Subtitle/Description */}
        {subtitle && (
          <Text 
            className={`text-sm font-roobert ${textColor} opacity-40`}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>
    </AnimatedPressable>
  );
}

