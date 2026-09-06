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
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Check, ChevronRight } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { cn } from '@/lib';
// Use react-native-gesture-handler's Pressable (not RN's own) for correct
// Android touch handling nested inside a BottomSheet's pan gesture — the
// same underlying gesture system @gorhom/bottom-sheet's legacy touchables
// module re-exported, without importing that retired module.
import { Pressable } from 'react-native-gesture-handler';
import { THEME } from '@/lib/utils/theme';

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

  /** Whether item is active */
  isActive?: boolean;
}

export function SelectableListItem({
  avatar,
  title,
  subtitle,
  meta,
  isSelected = false,
  showChevron = false,
  hideIndicator = false,
  isActive = true,
  onPress,
  accessibilityLabel,
  rightIcon,
}: SelectableListItemProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const c = isDark ? THEME.dark : THEME.light;

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.();
  };

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        pressed && { opacity: 0.7 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || `Select ${title}`}>
      {/* Left: Avatar + Text */}
      <View className="flex-1 flex-row items-center gap-2">
        {/* Avatar (no wrapping - passed directly) */}
        <View className={cn(isActive ? 'opacity-100' : 'opacity-30')}>{avatar}</View>

        {/* Text Content */}
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            {typeof title === 'string' ? (
              <Text
                className="font-roobert-medium text-base text-foreground"
                numberOfLines={1}>
                {title}
              </Text>
            ) : (
              title
            )}

            {/* Inactive badge */}
            {!isActive && (
              <Text
                className="mt-0.5 font-roobert text-muted-foreground"
                style={{ fontSize: 12, lineHeight: 16 }}>
                Inactive
              </Text>
            )}
          </View>
          {subtitle && (
            <Text
              className="mt-0.5 font-roobert text-muted-foreground"
              style={{ fontSize: 12, lineHeight: 16 }}
              numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>

        {/* Optional Meta (right side of text) */}
        {meta && (
          <Text
            className="ml-2 font-roobert-medium text-muted-foreground"
            style={{ fontSize: 12, lineHeight: 16 }}>
            {meta}
          </Text>
        )}
      </View>

      {/* Right: Selection Indicator or Right Icon */}
      {rightIcon && <View className="mr-2">{rightIcon}</View>}
      {!hideIndicator && (
        <View className="w-6 items-center justify-center">
          {showChevron ? (
            <ChevronRight size={18} color={c.mutedForeground} />
          ) : isSelected ? (
            <View
              style={{ backgroundColor: c.foreground }}
              className="h-5 w-5 items-center justify-center rounded-full">
              <Check size={12} color={c.background} strokeWidth={3} />
            </View>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}
