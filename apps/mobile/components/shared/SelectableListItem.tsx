/**
 * SelectableListItem Component - Unified selectable list item
 * 
 * A single, reusable list item component for all entity types:
 * - Agents/Workers
 * - Models
 * - Threads/Chats
 * - Triggers
 * - Any selectable entity
 * 
 * Features:
 * - Consistent selection states across all lists
 * - Checkmark for selected items
 * - Chevron for navigation items
 * - Avatar integration (no wrapping)
 * - Haptic feedback
 * - Spring animations
 * - Dark/Light mode support
 * 
 * Design Specifications (from Figma):
 * - Height: Auto (min 48px with avatar)
 * - Gap between avatar and text: 8px (gap-2)
 * - Selection indicator: 20px circle with check (dark) or chevron (navigation)
 * - Press animation: Scale to 0.98
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
import { Check, ChevronRight } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface SelectableListItemProps {
  /** Avatar component (AgentAvatar, ModelAvatar, etc.) */
  avatar: ReactNode;
  
  /** Primary title (can be string or ReactNode for custom styling) */
  title: string | ReactNode;
  
  /** Optional subtitle */
  subtitle?: string;
  
  /** Optional metadata (date, status, etc.) */
  meta?: string;
  
  /** Whether item is selected */
  isSelected?: boolean;
  
  /** Show chevron for navigation (default: false) */
  showChevron?: boolean;
  
  /** Hide all selection indicators (no chevron, no checkmark) */
  hideIndicator?: boolean;
  
  /** Press handler */
  onPress?: () => void;
  
  /** Accessibility label */
  accessibilityLabel?: string;
  
  /** Custom selection background */
  selectionBackground?: string;
  
  /** Right icon (e.g., Crown for premium) */
  rightIcon?: ReactNode;
}

export function SelectableListItem({
  avatar,
  title,
  subtitle,
  meta,
  isSelected = false,
  showChevron = false,
  hideIndicator = false,
  onPress,
  accessibilityLabel,
  selectionBackground,
  rightIcon,
}: SelectableListItemProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.();
  };

  // Selection background (optional, from Figma: #e0e0e0 light, #232324 dark)
  const defaultSelectionBg = isSelected && !showChevron
    ? (colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.12)' : 'rgba(18, 18, 21, 0.08)')
    : 'transparent';

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[
        animatedStyle,
      ]}
      className="flex-row items-center justify-between active:opacity-70"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || `Select ${title}`}
    >
      {/* Left: Avatar + Text */}
      <View className="flex-row items-center gap-2 flex-1">
        {/* Avatar (no wrapping - passed directly) */}
        {avatar}
        
        {/* Text Content */}
        <View className="flex-1">
          {typeof title === 'string' ? (
            <Text 
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="text-base font-roobert-medium"
              numberOfLines={1}
            >
              {title}
            </Text>
          ) : (
            title
          )}
          {subtitle && (
            <Text 
              style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
              className="text-xs font-roobert mt-0.5"
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          )}
        </View>
        
        {/* Optional Meta (right side of text) */}
        {meta && (
          <Text 
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
            className="text-xs font-roobert-medium ml-2"
          >
            {meta}
          </Text>
        )}
      </View>
      
      {/* Right: Selection Indicator or Right Icon */}
      {rightIcon && (
        <View className="mr-2">
          {rightIcon}
        </View>
      )}
      {!hideIndicator && (
        <View className="w-6 items-center justify-center">
          {showChevron ? (
            <ChevronRight 
              size={18} 
              color={colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'} 
            />
          ) : isSelected ? (
            <View 
              style={{ backgroundColor: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="w-5 h-5 rounded-full items-center justify-center"
            >
              <Check 
                size={12} 
                color={colorScheme === 'dark' ? '#121215' : '#f8f8f8'}
                strokeWidth={3} 
              />
            </View>
          ) : null}
        </View>
      )}
    </AnimatedPressable>
  );
}

