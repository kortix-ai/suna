import { Text } from '@/components/ui/text';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { QuickActionOptionCard } from './QuickActionOptionCard';
import { getQuickActionOptions } from './quickActionViews';
import { useLanguage } from '@/contexts';

interface QuickActionExpandedViewProps {
  actionId: string;
  actionLabel: string;
  onBack: () => void;
  onSelectOption: (optionId: string) => void;
  selectedOptionId?: string | null;
}

/**
 * QuickActionExpandedView Component
 * 
 * Replaces the quick action bar when an action is selected.
 * Shows custom options specific to the selected action.
 */
export function QuickActionExpandedView({ 
  actionId, 
  actionLabel,
  onBack,
  onSelectOption,
  selectedOptionId 
}: QuickActionExpandedViewProps) {
  const { t } = useLanguage();
  const options = getQuickActionOptions(actionId);

  return (
    <Animated.View 
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      className="mb-3"
    >
      {/* Header */}
      <View className="flex-row items-center mb-2 px-6">
        <Text className="text-sm font-roobert-medium text-foreground">
          {t('quickActions.chooseStyle', { action: actionLabel })}
        </Text>
      </View>

      {/* Options Grid */}
      <ScrollView 
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 24 }}
        className="flex-row"
      >
        {options.map((option) => (
          <QuickActionOptionCard 
            key={option.id} 
            option={option}
            actionId={actionId}
            onPress={onSelectOption}
            isSelected={selectedOptionId === option.id}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
}

