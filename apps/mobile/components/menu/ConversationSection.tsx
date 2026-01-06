import * as React from 'react';
import { View } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { EntityList } from '@/components/shared/EntityList';
import { ConversationItem } from './ConversationItem';
import { getTimePeriodLabel } from '@/lib/utils/thread-utils';
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
  
  // Use period label if available (for relative time grouping), otherwise use the period key
  const sectionTitle = React.useMemo(() => {
    if (section.periodLabel) {
      return getTimePeriodLabel(section.periodLabel as any, currentLanguage);
    }
    // Fallback: use the section id which might be a period key
    const periodKeys = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'older'];
    if (periodKeys.includes(section.id)) {
      return getTimePeriodLabel(section.id as any, currentLanguage);
    }
    return section.id;
  }, [section.periodLabel, section.id, currentLanguage]);
  
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

