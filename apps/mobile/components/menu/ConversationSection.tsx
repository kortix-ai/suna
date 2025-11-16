import * as React from 'react';
import { View } from 'react-native';
import { useLanguage } from '@/contexts';
import { formatMonthYear } from '@/lib/utils/date';
import { Text } from '@/components/ui/text';
import { EntityList } from '@/components/shared/EntityList';
import { ConversationItem } from './ConversationItem';
import type { ConversationSection as ConversationSectionType, Conversation } from './types';

interface ConversationSectionProps {
  section: ConversationSectionType;
  onConversationPress?: (conversation: Conversation) => void;
}

/**
 * ConversationSection Component (Compact - Figma: 375-10436)
 * 
 * Groups conversations by time period with unified EntityList.
 * - Section title: Roobert-Medium 14px at 50% opacity
 * - Gap between title and items: 12px (gap-3)
 * - Gap between items: 16px (gap-4) via EntityList
 */
export function ConversationSection({ 
  section, 
  onConversationPress 
}: ConversationSectionProps) {
  const { currentLanguage, t } = useLanguage();
  
  // Format section title based on current locale
  const sectionTitle = React.useMemo(
    () => formatMonthYear(section.timestamp, currentLanguage),
    [section.timestamp, currentLanguage]
  );
  
  return (
    <View className="gap-3 w-full">
      <Text className="text-sm font-roobert-medium text-foreground opacity-50">
        {sectionTitle}
      </Text>
      <EntityList
        entities={section.conversations}
        gap={4}
        emptyMessage={t('conversations.noConversationsInPeriod', 'No conversations in this period')}
        renderItem={(conversation) => (
          <ConversationItem
            key={conversation.id}
            conversation={conversation}
            onPress={onConversationPress}
          />
        )}
      />
    </View>
  );
}

