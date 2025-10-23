import * as React from 'react';
import { View } from 'react-native';
import { useLanguage } from '@/contexts';
import { formatMonthYear } from '@/lib/utils/date';
import { Text } from '@/components/ui/text';
import { ConversationItem } from './ConversationItem';
import type { ConversationSection as ConversationSectionType, Conversation } from './types';

interface ConversationSectionProps {
  section: ConversationSectionType;
  onConversationPress?: (conversation: Conversation) => void;
}

/**
 * ConversationSection Component (Compact - Figma: 375-10436)
 * 
 * Groups conversations by time period with compact spacing.
 * - Section title: Roobert-Medium 14px at 50% opacity
 * - Gap between title and items: 12px (gap-3)
 * - Gap between items: 24px (gap-6)
 */
export function ConversationSection({ 
  section, 
  onConversationPress 
}: ConversationSectionProps) {
  const { currentLanguage } = useLanguage();
  
  // Format section title based on current locale
  const sectionTitle = React.useMemo(
    () => formatMonthYear(section.timestamp, currentLanguage),
    [section.timestamp, currentLanguage]
  );
  
  return (
    <View className="gap-3 w-full">
      {/* Section Title - 14px at 50% opacity, no left padding for cleaner look */}
      <Text className="text-sm font-roobert-medium text-foreground opacity-50">
        {sectionTitle}
      </Text>
      
      {/* Conversations List - 24px gaps between items */}
      <View className="gap-6">
        {section.conversations.map((conversation) => (
          <ConversationItem
            key={conversation.id}
            conversation={conversation}
            onPress={onConversationPress}
          />
        ))}
      </View>
    </View>
  );
}

