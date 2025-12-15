/**
 * Trigger List Component - Unified trigger list
 *
 * Uses unified EntityList and SelectableListItem for consistency
 * Splits triggers into Running and Paused sections
 */

import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
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
  // Split triggers into Running and Paused
  const runningTriggers = React.useMemo(
    () => triggers.filter((trigger) => trigger.is_active),
    [triggers]
  );

  const pausedTriggers = React.useMemo(
    () => triggers.filter((trigger) => !trigger.is_active),
    [triggers]
  );

  if (isLoading) {
    return (
      <View className="items-center justify-center py-16">
        <Text className="font-roobert text-sm text-muted-foreground">Loading triggers...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View className="items-center justify-center py-16">
        <Text className="font-roobert text-sm text-destructive">
          Failed to load triggers. Please try again.
        </Text>
      </View>
    );
  }

  if (triggers.length === 0) {
    return (
      <View className="items-center justify-center py-16">
        <Text className="font-roobert text-sm text-muted-foreground">No triggers available</Text>
      </View>
    );
  }

  return (
    <View className="gap-6">
      {/* Running Section */}
      {runningTriggers.length > 0 && (
        <View className="gap-3">
          <Text className="font-roobert-medium text-sm text-foreground">Running</Text>
          <View className="gap-2">
            {runningTriggers.map((trigger) => (
              <TriggerListItem
                key={trigger.trigger_id}
                trigger={trigger}
                onPress={onTriggerPress}
                showChevron={showChevron}
              />
            ))}
          </View>
        </View>
      )}

      {/* Paused Section */}
      {pausedTriggers.length > 0 && (
        <View className="gap-3">
          <Text className="font-roobert-medium text-sm text-foreground">Paused</Text>
          <View className="gap-2">
            {pausedTriggers.map((trigger) => (
              <TriggerListItem
                key={trigger.trigger_id}
                trigger={trigger}
                onPress={onTriggerPress}
                showChevron={showChevron}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
