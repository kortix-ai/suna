import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { QuickActionCard } from './QuickActionCard';
import { QuickActionExpandedView } from './QuickActionExpandedView';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';


interface QuickActionBarProps {
  actions?: QuickAction[];
  onActionPress?: (actionId: string) => void;
  selectedActionId?: string | null;
  selectedOptionId?: string | null;
  onSelectOption?: (optionId: string) => void;
  onSelectPrompt?: (prompt: string) => void;
}


export function QuickActionBar({ 
  actions = QUICK_ACTIONS,
  onActionPress,
  selectedActionId,
  selectedOptionId,
  onSelectOption,
  onSelectPrompt
}: QuickActionBarProps) {
  const enhancedActions = React.useMemo(() => 
    actions.map(action => ({
      ...action,
      onPress: () => onActionPress?.(action.id),
      isSelected: selectedActionId === action.id,
    })),
    [actions, onActionPress, selectedActionId]
  );

  const selectedAction = actions.find(a => a.id === selectedActionId);

  if (selectedActionId && selectedAction) {
    return (
      <View className="mb-2 py-2">
        <QuickActionExpandedView
          actionId={selectedActionId}
          actionLabel={selectedAction.label}
          onBack={() => onActionPress?.(selectedActionId)}
          onSelectOption={(optionId) => onSelectOption?.(optionId)}
          selectedOptionId={selectedOptionId}
          onSelectPrompt={onSelectPrompt}
        />
      </View>
    );
  }

  return (
    <View className="mb-4 py-2">
      <ScrollView 
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        className="flex-row"
      >
        {enhancedActions.map((action) => (
          <QuickActionCard key={action.id} action={action} />
        ))}
      </ScrollView>
    </View>
  );
}

