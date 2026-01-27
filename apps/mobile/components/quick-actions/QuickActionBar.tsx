import * as React from 'react';
import { View, Dimensions, Pressable, Platform, ScrollView } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  useDerivedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';
import { useLanguage } from '@/contexts';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ITEM_SPACING = 8;
const CONTAINER_PADDING = 16;

// Ultra-snappy spring - instant response like iOS native
const SPRING_CONFIG = {
  damping: 28,
  stiffness: 500,
  mass: 0.5,
};

// Android hit slop for better touch targets
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 12, bottom: 12, left: 12, right: 12 } : undefined;

interface QuickActionBarProps {
  actions?: QuickAction[];
  onActionPress?: (actionId: string) => void;
  selectedActionId?: string | null;
}

interface ModeItemProps {
  action: QuickAction;
  index: number;
  animatedIndex: Animated.SharedValue<number>;
  onPress: () => void;
  isLast: boolean;
}

// Optimized ModeItem - derives animation from parent's shared value
// No useEffect, no per-item state updates - pure UI thread animation
const ModeItem = React.memo(({ action, index, animatedIndex, onPress, isLast }: ModeItemProps) => {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });

  // Derive selection progress from parent's animated index - runs on UI thread
  const selectionProgress = useDerivedValue(() => {
    const distance = Math.abs(animatedIndex.value - index);
    return Math.max(0, 1 - distance);
  }, [index]);

  // Animated style - 100% UI thread, no JS bridge
  const animatedStyle = useAnimatedStyle(() => {
    const progress = selectionProgress.value;
    return {
      opacity: interpolate(progress, [0, 1], [0.45, 1]),
      transform: [{ scale: interpolate(progress, [0, 1], [0.94, 1]) }],
    };
  });

  // Icon color based on theme
  const iconColor = colorScheme === 'dark' ? '#F8F8F8' : '#121215';

  return (
    <Pressable
      onPress={onPress}
      hitSlop={ANDROID_HIT_SLOP}
      style={{
        marginRight: isLast ? 0 : ITEM_SPACING,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View style={[{ alignItems: 'center', justifyContent: 'center' }, animatedStyle]}>
        <View
          className="bg-muted/50 rounded-2xl py-2.5 flex-row items-center"
          style={{ paddingHorizontal: 12 }}
        >
          <Icon
            as={action.icon}
            size={18}
            color={iconColor}
            strokeWidth={2}
            style={{ marginRight: 6, flexShrink: 0 }}
          />
          <Text className="text-sm font-roobert-medium text-foreground">
            {translatedLabel}
          </Text>
        </View>
      </Animated.View>
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

  // Find the index of the selected action
  const selectedIndex = React.useMemo(() => {
    const index = actions.findIndex(a => a.id === selectedActionId);
    return index >= 0 ? index : 0;
  }, [actions, selectedActionId]);

  // Single shared value for the entire bar - drives all item animations
  // Key insight: we animate this IMMEDIATELY on tap, before React state updates
  const animatedIndex = useSharedValue(selectedIndex);

  // Store item positions for scrolling
  const itemPositions = React.useRef<number[]>([]);
  const itemWidths = React.useRef<number[]>([]);

  // Track last pressed to avoid double-taps
  const lastPressedRef = React.useRef<string | null>(null);

  // Measure items and calculate positions
  const measureItem = React.useCallback((index: number, width: number, x: number) => {
    itemWidths.current[index] = width;
    itemPositions.current[index] = x;
  }, []);

  // Scroll to center an item
  const scrollToIndex = React.useCallback((index: number) => {
    if (itemPositions.current[index] !== undefined && itemWidths.current[index] !== undefined) {
      const itemX = itemPositions.current[index];
      const itemWidth = itemWidths.current[index];
      const itemCenter = itemX + (itemWidth / 2);
      const offset = itemCenter - (SCREEN_WIDTH / 2);
      scrollViewRef.current?.scrollTo({ x: Math.max(0, offset), animated: true });
    }
  }, []);

  // Sync animation when parent state changes (e.g., from external source)
  React.useEffect(() => {
    // Only animate if this wasn't triggered by our own tap
    if (lastPressedRef.current !== selectedActionId) {
      animatedIndex.value = withSpring(selectedIndex, SPRING_CONFIG);
      scrollToIndex(selectedIndex);
    }
    lastPressedRef.current = null;
  }, [selectedIndex, animatedIndex, scrollToIndex, selectedActionId]);

  // Handle tap - INSTANT animation, then notify parent
  const handleItemPress = React.useCallback((index: number, actionId: string) => {
    // Skip if same item
    if (actionId === selectedActionId) return;

    // Mark this as our tap (so useEffect doesn't double-animate)
    lastPressedRef.current = actionId;

    // 1. Haptic - instant feedback
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // 2. Animate IMMEDIATELY - don't wait for React state
    animatedIndex.value = withSpring(index, SPRING_CONFIG);

    // 3. Scroll to center
    scrollToIndex(index);

    // 4. Notify parent (this triggers React state update, but animation already started)
    onActionPress?.(actionId);
  }, [onActionPress, selectedActionId, animatedIndex, scrollToIndex]);

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
        scrollEventThrottle={16}
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
              animatedIndex={animatedIndex}
              onPress={() => handleItemPress(index, action.id)}
              isLast={index === actions.length - 1}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
