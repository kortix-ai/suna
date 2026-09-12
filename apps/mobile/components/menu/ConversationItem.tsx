/**
 * Conversation Item Component - Unified thread item using SelectableListItem
 *
 * Uses the unified SelectableListItem with ThreadAvatar
 * Ensures consistent design across all list types
 * Supports native context menu for delete action
 */

import * as React from 'react';
import { View, Pressable, Alert, Platform, ActivityIndicator } from 'react-native';
import { useLanguage } from '@/contexts';
import { formatConversationDate } from '@/lib/utils/date';
import { ThreadAvatar } from '@/components/kortix/ThreadAvatar';
import { Text } from '@/components/ui/text';
import * as Haptics from 'expo-haptics';
import type { Conversation } from './types';
import { useColorScheme } from 'nativewind';
import { log } from '@/lib/logger';
import { THEME } from '@/lib/utils/theme';

// Only import ContextMenu on native platforms (iOS/Android)
let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    log.warn('react-native-context-menu-view not available');
  }
}

interface ConversationItemProps {
  conversation: Conversation;
  onPress?: (conversation: Conversation) => void;
  onDelete?: (conversation: Conversation) => void;
  showChevron?: boolean;
  isDeleting?: boolean;
}

/**
 * ConversationItem Component
 *
 * Individual conversation list item with avatar, title, preview, and date.
 * Supports native context menu for delete action.
 */
export function ConversationItem({
  conversation,
  onPress,
  onDelete,
  showChevron = false,
  isDeleting = false,
}: ConversationItemProps) {
  const { currentLanguage, t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDarkMode = colorScheme === 'dark';
  const c = isDarkMode ? THEME.dark : THEME.light;

  const formattedDate = React.useMemo(
    () => formatConversationDate(conversation.timestamp, currentLanguage),
    [conversation.timestamp, currentLanguage]
  );

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.(conversation);
  };

  const handleDelete = () => {
    Alert.alert(
      t('threadActions.deleteThread') || 'Delete Chat',
      t('threadActions.deleteConfirm') || 'Are you sure you want to delete this chat? This action cannot be undone.',
      [
        {
          text: t('common.cancel') || 'Cancel',
          style: 'cancel',
        },
        {
          text: t('common.delete') || 'Delete',
          style: 'destructive',
          onPress: () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onDelete?.(conversation);
          },
        },
      ]
    );
  };

  // The inner content (avatar, text, date)
  const innerContent = (
    <View className="flex-1 flex-row items-center gap-2" style={{ opacity: isDeleting ? 0.5 : 1 }}>
      {/* Avatar or Loading Indicator */}
      {isDeleting ? (
        <View
          className="bg-muted"
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ActivityIndicator size="small" color={c.foreground} />
        </View>
      ) : (
        <ThreadAvatar
          title={conversation.title}
          icon={conversation.iconName || conversation.icon}
          size={48}
          backgroundColor={c.muted}
          className="flex-row items-center justify-center"
          style={{
            borderWidth: 0,
          }}
        />
      )}

      {/* Text Content */}
      <View className="flex-1">
        <Text
          className="font-roobert-medium text-base text-foreground"
          numberOfLines={1}
        >
          {conversation.title}
        </Text>
        {conversation.preview && (
          <Text
            className="mt-0.5 font-roobert text-muted-foreground"
            style={{ fontSize: 12, lineHeight: 16 }}
            numberOfLines={1}
          >
            {conversation.preview}
          </Text>
        )}
      </View>

      {/* Meta (date) */}
      {formattedDate && (
        <Text
          className="ml-2 font-roobert-medium text-muted-foreground"
          style={{ fontSize: 12, lineHeight: 16 }}
        >
          {formattedDate}
        </Text>
      )}
    </View>
  );

  // Use native context menu on iOS/Android
  // Matches user message bubble pattern exactly
  if (ContextMenu) {
    return (
      <ContextMenu
        actions={[
          { title: t('threadActions.deleteThread') || 'Delete', systemIcon: 'trash', destructive: true },
        ]}
        onPress={(e: any) => {
          if (e.nativeEvent.index === 0) {
            handleDelete();
          }
        }}
        dropdownMenuMode={false}
      >
        <View
          className="bg-background"
          style={{ overflow: 'hidden' }}
        >
          <Pressable
            onPress={handlePress}
            className="flex-row items-center justify-between"
            accessibilityRole="button"
            accessibilityLabel={`Open conversation: ${conversation.title}`}
            accessibilityHint={t('accessibility.longPressToDelete') || 'Long press for more options'}
          >
            {innerContent}
          </Pressable>
        </View>
      </ContextMenu>
    );
  }

  // Fallback for web - use long press
  return (
    <Pressable
      onLongPress={handleDelete}
      delayLongPress={500}
      onPress={handlePress}
      className="flex-row items-center justify-between"
      accessibilityRole="button"
      accessibilityLabel={`Open conversation: ${conversation.title}`}
    >
      {innerContent}
    </Pressable>
  );
}
