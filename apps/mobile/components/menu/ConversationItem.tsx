/**
 * Conversation Item Component
 * 
 * Individual conversation list item using the generic ListItem component
 */

import * as React from 'react';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { formatConversationDate } from '@/lib/utils/date';
import { ListItem } from '@/components/shared/ListItem';
import { ThreadIcon } from '@/components/shared/ThreadIcon';
import type { Conversation } from './types';

interface ConversationItemProps {
  conversation: Conversation;
  onPress?: (conversation: Conversation) => void;
}

/**
 * ConversationItem Component
 * 
 * Individual conversation list item with icon, title, date, and optional preview.
 * Uses the generic ListItem component for consistent design.
 */
export function ConversationItem({ conversation, onPress }: ConversationItemProps) {
  const { colorScheme } = useColorScheme();
  const { currentLanguage } = useLanguage();
  
  // Format date based on current locale
  const formattedDate = React.useMemo(
    () => formatConversationDate(conversation.timestamp, currentLanguage),
    [conversation.timestamp, currentLanguage]
  );
  
  const iconColor = colorScheme === 'dark' ? 'text-white' : 'text-black';
  
  // Custom icon element
  const iconElement = (
    <ThreadIcon 
      iconName={conversation.iconName}
      size={20}
      className={iconColor}
    />
  );
  
  return (
    <ListItem
      iconElement={iconElement}
      title={conversation.title}
      subtitle={conversation.preview}
      meta={formattedDate}
      onPress={() => onPress?.(conversation)}
      accessibilityLabel={`Open conversation: ${conversation.title}`}
      marginBottom={0}
    />
  );
}
