import * as React from 'react';
import { View, Dimensions, Pressable, Platform, ScrollView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';
import { useLanguage } from '@/contexts';
import { log } from '@/lib/logger';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ITEM_SPACING = 8; // Consistent spacing between items (always the same)
const CONTAINER_PADDING = 16; // Padding on sides

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
  isLast: boolean;
}

const ModeItem = React.memo(({ action, index, isSelected, onPress, isLast }: ModeItemProps) => {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });

  // Get icon color based on theme and selection state
  // Primary: #121215 (light) / #F8F8F8 (dark)
  // Foreground: #121215 (light) / #F8F8F8 (dark)
  const iconColor = React.useMemo(() => {
    if (isSelected) {
      return colorScheme === 'dark' ? '#F8F8F8' : '#121215'; // primary
    }
    return colorScheme === 'dark' ? '#F8F8F8' : '#121215'; // foreground
  }, [isSelected, colorScheme]);

  return (
    <Pressable 
      onPress={onPress} 
      hitSlop={ANDROID_HIT_SLOP}
      style={{
        marginRight: isLast ? 0 : ITEM_SPACING, // Consistent spacing between items, no margin on last
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isSelected ? 1 : 0.5,
          transform: [{ scale: isSelected ? 1 : 0.9 }],
        }}
      >
        <View 
          className="bg-muted/50 rounded-2xl py-2.5 flex-row items-center"
          style={{
            paddingHorizontal: 12,
          }}
        >
          <Icon 
            as={action.icon} 
            size={18} 
            color={iconColor}
            className={isSelected ? 'text-primary' : 'text-foreground'}
            strokeWidth={2}
            style={{ marginRight: 6, flexShrink: 0 }}
          />
          <Text 
            className={`text-sm font-roobert-medium ${isSelected ? 'text-primary' : 'text-foreground'}`}
          >
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

  // Store item positions for scrolling
  const itemPositions = React.useRef<number[]>([]);
  const itemWidths = React.useRef<number[]>([]);

  // Measure items and calculate positions
  // x is relative to the contentContainer (which includes padding)
  const measureItem = React.useCallback((index: number, width: number, x: number) => {
    itemWidths.current[index] = width;
    itemPositions.current[index] = x;
  }, []);

  // Scroll to selected item when it changes
  React.useEffect(() => {
    if (itemPositions.current[selectedIndex] !== undefined && itemWidths.current[selectedIndex] !== undefined) {
      const itemX = itemPositions.current[selectedIndex];
      const itemWidth = itemWidths.current[selectedIndex];
      const itemCenter = itemX + (itemWidth / 2);
      const offset = itemCenter - (SCREEN_WIDTH / 2);
      scrollViewRef.current?.scrollTo({ x: Math.max(0, offset), animated: true });
    }
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
    log.log('🎯 Quick action item pressed:', index, actions[index]?.id);
    handleModeChange(index);
  }, [handleModeChange, actions]);

  return (
    <View className="w-full overflow-hidden">
      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: CONTAINER_PADDING,
          flexDirection: 'row',
          alignItems: 'center',
        }}
        decelerationRate="fast"
      >
        {actions.map((action, index) => (
          <View
            key={action.id}
            onLayout={(event) => {
              const { width, x } = event.nativeEvent.layout;
              measureItem(index, width, x);
            }}
          >
            <ModeItem
              action={action}
              index={index}
              isSelected={index === selectedIndex}
              onPress={() => handleItemPress(index)}
              isLast={index === actions.length - 1}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
