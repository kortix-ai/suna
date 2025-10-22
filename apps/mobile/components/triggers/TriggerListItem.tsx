/**
 * Trigger List Item Component
 * 
 * Displays individual trigger using the generic ListItem component
 * Ensures proper theme consistency with design system colors
 */

import React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
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
  const { colorScheme } = useColorScheme();
  const IconComponent = getTriggerIcon(trigger.trigger_type);
  const category = getTriggerCategory(trigger.trigger_type);

  // Get schedule info for display
  const subtitle = React.useMemo(() => {
    if (category === 'scheduled' && trigger.config?.cron_expression) {
      return formatCronExpression(trigger.config.cron_expression);
    }
    return trigger.description || undefined;
  }, [category, trigger.config, trigger.description]);

  // Status indicator dot with design system colors
  const statusIndicator = (
    <View 
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: trigger.is_active 
          ? '#22C55E'  // Green for active
          : (colorScheme === 'dark' ? '#666666' : '#9CA3AF')  // Gray for inactive
      }}
    />
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
