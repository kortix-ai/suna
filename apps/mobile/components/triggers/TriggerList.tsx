/**
 * Trigger List Component - Unified trigger list
 * 
 * Uses unified EntityList and SelectableListItem for consistency
 */

import React from 'react';
import { EntityList } from '@/components/shared/EntityList';
import { TriggerListItem } from './TriggerListItem';
import type { TriggerWithAgent } from '@/api/types';

interface TriggerListProps {
  triggers: TriggerWithAgent[];
  onTriggerPress?: (trigger: TriggerWithAgent) => void;
  isLoading?: boolean;
  error?: Error | null;
  searchQuery?: string;
  showChevron?: boolean;
}

export function TriggerList({
  triggers,
  onTriggerPress,
  isLoading = false,
  error = null,
  searchQuery = '',
  showChevron = true,
}: TriggerListProps) {
  return (
    <EntityList
      entities={triggers}
      isLoading={isLoading}
      error={error}
      searchQuery={searchQuery}
      emptyMessage="No triggers available"
      noResultsMessage="No triggers found"
      loadingMessage="Loading triggers..."
      gap={4}
      renderItem={(trigger) => (
        <TriggerListItem
          key={trigger.trigger_id}
          trigger={trigger}
          onPress={onTriggerPress}
          showChevron={showChevron}
        />
      )}
    />
  );
}
