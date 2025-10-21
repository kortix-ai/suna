/**
 * Trigger List Item Component
 * 
 * Displays individual trigger using the generic ListItem component
 */

import React from 'react';
import { View } from 'react-native';
import { ListItem } from '@/components/shared/ListItem';
import { getTriggerIcon, formatCronExpression, getTriggerCategory } from '@/lib/utils/trigger-utils';
import type { TriggerWithAgent } from '@/api/types';
import { AgentAvatar } from '@/components/agents/AgentAvatar';

interface TriggerListItemProps {
  trigger: TriggerWithAgent;
  onPress?: (trigger: TriggerWithAgent) => void;
}

export function TriggerListItem({
  trigger,
  onPress,
}: TriggerListItemProps) {
  const IconComponent = getTriggerIcon(trigger.trigger_type);
  const category = getTriggerCategory(trigger.trigger_type);

  // Get schedule info for display
  const subtitle = React.useMemo(() => {
    if (category === 'scheduled' && trigger.config?.cron_expression) {
      return formatCronExpression(trigger.config.cron_expression);
    }
    return trigger.description || undefined;
  }, [category, trigger.config, trigger.description]);

  // Status indicator dot
  const statusIndicator = (
    <View className={`w-2 h-2 rounded-full ${trigger.is_active ? 'bg-green-500' : 'bg-gray-400'}`} />
  );

  return (
    <ListItem
      icon={IconComponent}
      title={trigger.name}
      subtitle={subtitle}
      statusIndicator={statusIndicator}
      onPress={() => onPress?.(trigger)}
      accessibilityLabel={`Open trigger: ${trigger.name}. Status: ${trigger.is_active ? 'Active' : 'Inactive'}`}
      marginBottom={12}
    />
  );
}
