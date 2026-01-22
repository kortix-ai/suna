/**
 * Conversation Item Component - Unified thread item using SelectableListItem
 *
 * Uses the unified SelectableListItem with ThreadAvatar
 * Ensures consistent design across all list types
 */

import * as React from 'react';
import { View } from 'react-native';
import { useLanguage } from '@/contexts';
import { formatConversationDate } from '@/lib/utils/date';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { ThreadAvatar } from '@/components/ui/ThreadAvatar';
import type { Conversation } from './types';
import { useColorScheme } from 'nativewind';

interface ConversationItemProps {
  conversation: Conversation;
  onPress?: (conversation: Conversation) => void;
  showChevron?: boolean;
}

/**
 * ConversationItem Component
 *
 * Individual conversation list item with avatar, title, preview, and date.
 * Uses the unified SelectableListItem for consistent design.
 */
export function ConversationItem({
  conversation,
  onPress,
  showChevron = false,
}: ConversationItemProps) {
  const { currentLanguage } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const formattedDate = React.useMemo(
    () => formatConversationDate(conversation.timestamp, currentLanguage),
    [conversation.timestamp, currentLanguage]
  );
  
  const mutedIconColor = isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)';

  return (
    <View style={{ backgroundColor: 'transparent' }}>
      <SelectableListItem
        avatar={
          <ThreadAvatar
            title={conversation.title}
            icon={conversation.iconName || conversation.icon}
            size={48}
            className="flex-row items-center justify-center"
            backgroundColor="transparent"
            iconColor={mutedIconColor}
            style={{
              borderWidth: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              height: 40,
              width: 'auto',
              paddingRight: 12,
            }}
          />
        }
        isActive
        title={conversation.title}
        subtitle={conversation.preview}
        meta={formattedDate}
        hideIndicator
        onPress={() => onPress?.(conversation)}
        accessibilityLabel={`Open conversation: ${conversation.title}`}
      />
    </View>
  );
}
