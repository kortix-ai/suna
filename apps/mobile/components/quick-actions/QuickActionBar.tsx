import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { QuickActionCard } from './QuickActionCard';
import { QuickActionExpandedView } from './QuickActionExpandedView';
import { QUICK_ACTIONS } from './quickActions';
import type { QuickAction } from '../shared/types';

interface QuickActionBarProps {
  actions?: QuickAction[];
  onActionPress?: (actionId: string) => void;
  selectedActionId?: string | null;
  selectedOptionId?: string | null;
  onSelectOption?: (optionId: string) => void;
}

/**
 * QuickActionBar Component
 * 
 * Horizontal scrollable bar of quick action cards.
 * Appears above the chat input for quick access to common actions.
 */
export function QuickActionBar({ 
  actions = QUICK_ACTIONS,
  onActionPress,
  selectedActionId,
  selectedOptionId,
  onSelectOption 
}: QuickActionBarProps) {
  // Enhance actions with onPress handler
  const enhancedActions = React.useMemo(() => 
    actions.map(action => ({
      ...action,
      onPress: () => onActionPress?.(action.id),
      isSelected: selectedActionId === action.id,
    })),
    [actions, onActionPress, selectedActionId]
  );

  // Get selected action label
  const selectedAction = actions.find(a => a.id === selectedActionId);

  // If an action is selected, show expanded view
  if (selectedActionId && selectedAction) {
    return (
      <QuickActionExpandedView
        actionId={selectedActionId}
        actionLabel={selectedAction.label}
        onBack={() => onActionPress?.(selectedActionId)} // Toggle off
        onSelectOption={(optionId) => onSelectOption?.(optionId)}
        selectedOptionId={selectedOptionId}
      />
    );
  }

  // Otherwise show normal quick action bar
  return (
    <View className="mb-3">
      <ScrollView 
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 24 }}
        className="flex-row"
      >
        {enhancedActions.map((action) => (
          <QuickActionCard key={action.id} action={action} />
        ))}
      </ScrollView>
    </View>
  );
}

