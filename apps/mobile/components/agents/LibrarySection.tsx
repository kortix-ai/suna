/**
 * LibrarySection Component
 * 
 * Groups agents/workers by time period with unified styling.
 * Mirrors ConversationSection for visual consistency.
 * - Section title: Roobert-Medium 14px at 50% opacity
 * - Gap between title and items: 12px (gap-3)
 * - Gap between items: 16px (gap-4) via EntityList
 */

import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { EntityList } from '@/components/shared/EntityList';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { AgentAvatar } from './AgentAvatar';
import { formatConversationDate } from '@/lib/utils/date';
import { useLanguage } from '@/contexts';
import type { Agent } from '@/api/types';

interface LibrarySectionProps {
  label: string;
  agents: Agent[];
  selectedAgentId?: string;
  onAgentPress?: (agent: Agent) => void;
}

export function LibrarySection({ 
  label,
  agents,
  selectedAgentId,
  onAgentPress,
}: LibrarySectionProps) {
  const { currentLanguage } = useLanguage();

  return (
    <View className="gap-3 w-full">
      <Text className="text-sm font-roobert-medium text-foreground opacity-50">
        {label}
      </Text>
      <EntityList
        entities={agents}
        gap={4}
        emptyMessage="No workers in this period"
        renderItem={(agent) => (
          <SelectableListItem
            key={agent.agent_id}
            avatar={<AgentAvatar agent={agent} size={48} />}
            title={agent.name}
            subtitle={agent.description}
            meta={formatConversationDate(new Date(agent.created_at), currentLanguage)}
            isSelected={agent.agent_id === selectedAgentId}
            hideIndicator
            onPress={() => onAgentPress?.(agent)}
            accessibilityLabel={`Open ${agent.name} worker`}
            isActive
          />
        )}
      />
    </View>
  );
}

