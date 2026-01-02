/**
 * Conversation Item Component - Pill-shaped container design
 *
 * Matches Figma design: rounded-full container with icon and text
 * Selected items have bg-neutral-200 background
 */

import * as React from 'react';
import { Pressable } from 'react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { getIconFromName } from '@/lib/utils/icon-mapping';
import { MessageSquare } from 'lucide-react-native';
import type { Conversation } from './types';
import type { LucideIcon } from 'lucide-react-native';

interface ConversationItemProps {
  conversation: Conversation;
  onPress?: (conversation: Conversation) => void;
  isSelected?: boolean;
}

/**
 * ConversationItem Component
 *
 * Pill-shaped container with icon on left and text on right.
 * Selected items have bg-neutral-200 background.
 * Icons are dynamically loaded based on conversation.iconName or conversation.icon
 */
export function ConversationItem({
  conversation,
  onPress,
  isSelected = false,
}: ConversationItemProps) {
  const { colorScheme } = useColorScheme();

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.(conversation);
  };

  // Get the icon component - prioritize iconName from backend, fallback to icon prop
  const getIconComponent = (): LucideIcon => {
    if (conversation.iconName) {
      return getIconFromName(conversation.iconName);
    }
    return conversation.icon || MessageSquare;
  };

  const IconComponent = getIconComponent();

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        'h-12 flex-row items-center gap-3 px-4 rounded-full',
        isSelected
          ? 'bg-neutral-200 dark:bg-neutral-700'
          : 'bg-transparent'
      )}
      accessibilityRole="button"
      accessibilityLabel={`Open conversation: ${conversation.title}`}>
      {/* Icon - w-5 with no outer div or background */}
      <Icon
        as={IconComponent}
        size={20}
        className="w-5 text-neutral-600 dark:text-neutral-400"
        strokeWidth={2}
      />

      {/* Text */}
      <Text
        className="flex-1 text-base text-neutral-900 dark:text-neutral-50"
        style={{ fontFamily: 'Roobert-Medium' }}
        numberOfLines={1}>
        {conversation.title}
      </Text>
    </Pressable>
  );
}
