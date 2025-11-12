/**
 * Conversation Item Component - Unified thread item using SelectableListItem
 * 
 * Uses the unified SelectableListItem with ThreadAvatar
 * Ensures consistent design across all list types
 */

import * as React from 'react';
import { useLanguage } from '@/contexts';
import { formatConversationDate } from '@/lib/utils/date';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { ThreadAvatar } from '@/components/ui/ThreadAvatar';
import type { Conversation } from './types';

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
  showChevron = false 
}: ConversationItemProps) {
  const { currentLanguage } = useLanguage();
  
  // Format date based on current locale
  const formattedDate = React.useMemo(
    () => formatConversationDate(conversation.timestamp, currentLanguage),
    [conversation.timestamp, currentLanguage]
  );
  
  return (
    <SelectableListItem
      avatar={
        <ThreadAvatar 
          title={conversation.title} 
          icon={conversation.iconName || conversation.icon}
          size={48} 
          className="bg-primary flex-row items-center justify-center"
        />
      }
      title={conversation.title}
      subtitle={conversation.preview}
      meta={formattedDate}
      hideIndicator
      onPress={() => onPress?.(conversation)}
      accessibilityLabel={`Open conversation: ${conversation.title}`}
    />
  );
}
