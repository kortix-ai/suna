/**
 * Trigger List Item Component - Unified trigger item using SelectableListItem
 * 
 * Uses the unified SelectableListItem with TriggerAvatar
 * Ensures consistent design across all list types
 */

import React from 'react';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { TriggerAvatar } from './TriggerAvatar';
import { formatCronExpression, getTriggerCategory } from '@/lib/utils/trigger-utils';
import type { TriggerWithAgent } from '@/api/types';

interface TriggerListItemProps {
  trigger: TriggerWithAgent;
  onPress?: (trigger: TriggerWithAgent) => void;
  showChevron?: boolean;
}

export function TriggerListItem({
  trigger,
  onPress,
  showChevron = true,
}: TriggerListItemProps) {
  // Get schedule info for display
  const subtitle = React.useMemo(() => {
    const category = getTriggerCategory(trigger.trigger_type);
    if (category === 'scheduled' && trigger.config?.cron_expression) {
      return formatCronExpression(trigger.config.cron_expression);
    }
    return trigger.description || undefined;
  }, [trigger.trigger_type, trigger.config, trigger.description]);

  return (
    <SelectableListItem
      avatar={<TriggerAvatar trigger={trigger} size={48} />}
      title={trigger.name}
      subtitle={subtitle}
      showChevron={showChevron}
      onPress={() => onPress?.(trigger)}
      accessibilityLabel={`Open trigger: ${trigger.name}. Status: ${trigger.is_active ? 'Active' : 'Inactive'}`}
    />
  );
}
