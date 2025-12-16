import * as React from 'react';
import { View, Dimensions, Pressable, Platform, ScrollView } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';
import { useLanguage } from '@/contexts';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ITEM_WIDTH = 85;
const ITEM_SPACING = 8;
const TOTAL_ITEM_WIDTH = ITEM_WIDTH + ITEM_SPACING;

// Android hit slop for better touch targets
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 12, bottom: 12, left: 12, right: 12 } : undefined;

interface QuickActionBarProps {
  actions?: QuickAction[];
  onActionPress?: (actionId: string) => void;
  selectedActionId?: string | null;
  selectedOptionId?: string | null;
  onSelectOption?: (optionId: string) => void;
  onSelectPrompt?: (prompt: string) => void;
}

interface ModeItemProps {
  action: QuickAction;
  index: number;
  isSelected: boolean;
  onPress: () => void;
}

const ModeItem = React.memo(({ action, index, isSelected, onPress }: ModeItemProps) => {
  const { t } = useLanguage();
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });

  return (
    <Pressable onPress={onPress} hitSlop={ANDROID_HIT_SLOP}>
      <View
        style={{
          width: ITEM_WIDTH,
          marginHorizontal: ITEM_SPACING / 2,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isSelected ? 1 : 0.5,
          transform: [{ scale: isSelected ? 1 : 0.9 }],
        }}
      >
        <View className="bg-muted/50 rounded-2xl px-3 py-2.5 flex-row items-center gap-2">
          <Icon 
            as={action.icon} 
            size={18} 
            className="text-foreground"
            strokeWidth={2}
          />
          <Text className="text-sm font-roobert-medium text-foreground">
            {translatedLabel}
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

ModeItem.displayName = 'ModeItem';

export function QuickActionBar({ 
  actions = QUICK_ACTIONS,
  onActionPress,
  selectedActionId,
}: QuickActionBarProps) {
  const scrollViewRef = React.useRef<ScrollView>(null);
  const lastHapticIndex = React.useRef(-1);

  // Find the index of the selected action
  const selectedIndex = React.useMemo(() => {
    const index = actions.findIndex(a => a.id === selectedActionId);
    return index >= 0 ? index : 0;
  }, [actions, selectedActionId]);

  // Scroll to selected item when it changes
  React.useEffect(() => {
    const offset = (selectedIndex * TOTAL_ITEM_WIDTH) - (SCREEN_WIDTH / 2) + (TOTAL_ITEM_WIDTH / 2);
    scrollViewRef.current?.scrollTo({ x: Math.max(0, offset), animated: true });
  }, [selectedIndex]);

  // Handle mode change with haptic
  const handleModeChange = React.useCallback((newIndex: number) => {
    const clampedIndex = Math.max(0, Math.min(newIndex, actions.length - 1));
    if (clampedIndex !== lastHapticIndex.current) {
      lastHapticIndex.current = clampedIndex;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const newAction = actions[clampedIndex];
      if (newAction) {
        onActionPress?.(newAction.id);
      }
    }
  }, [actions, onActionPress]);

  // Handle direct tap on an item
  const handleItemPress = React.useCallback((index: number) => {
    console.log('🎯 Quick action item pressed:', index, actions[index]?.id);
    handleModeChange(index);
  }, [handleModeChange, actions]);

  return (
    <View className="w-full overflow-hidden">
      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: (SCREEN_WIDTH - TOTAL_ITEM_WIDTH) / 2,
        }}
        decelerationRate="fast"
        snapToInterval={TOTAL_ITEM_WIDTH}
        snapToAlignment="center"
      >
        {actions.map((action, index) => (
          <ModeItem
            key={action.id}
            action={action}
            index={index}
            isSelected={index === selectedIndex}
            onPress={() => handleItemPress(index)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
