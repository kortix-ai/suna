import * as React from 'react';
import { View, Dimensions, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
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
const SWIPE_THRESHOLD = 40;

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
  currentIndex: Animated.SharedValue<number>;
  onPress: () => void;
}

const ModeItem = React.memo(({ action, index, currentIndex, onPress }: ModeItemProps) => {
  const { t } = useLanguage();
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });

  const animatedContainerStyle = useAnimatedStyle(() => {
    const distance = Math.abs(currentIndex.value - index);
    
    const scale = interpolate(
      distance,
      [0, 1, 2],
      [1, 0.85, 0.75],
      Extrapolation.CLAMP
    );

    const opacity = interpolate(
      distance,
      [0, 1, 2],
      [1, 0.5, 0.3],
      Extrapolation.CLAMP
    );

    return {
      transform: [{ scale }],
      opacity,
    };
  });

  return (
    <Pressable onPress={onPress}>
      <Animated.View
        style={[
          {
            width: ITEM_WIDTH,
            marginHorizontal: ITEM_SPACING / 2,
            alignItems: 'center',
            justifyContent: 'center',
          },
          animatedContainerStyle,
        ]}
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
  // Current index as a continuous animated value for smooth transitions
  const currentIndex = useSharedValue(0);
  const startX = useSharedValue(0);
  const lastHapticIndex = React.useRef(-1);

  // Find the index of the selected action
  const selectedIndex = React.useMemo(() => {
    const index = actions.findIndex(a => a.id === selectedActionId);
    return index >= 0 ? index : 0;
  }, [actions, selectedActionId]);

  // Sync currentIndex with selectedIndex
  React.useEffect(() => {
    currentIndex.value = withSpring(selectedIndex, { 
      damping: 20, 
      stiffness: 200,
      mass: 0.8,
    });
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

  // Pan gesture for swiping
  const panGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .failOffsetY([-30, 30])
    .onStart(() => {
      startX.value = currentIndex.value;
    })
    .onUpdate((event) => {
      // Convert translation to index movement
      const indexDelta = -event.translationX / TOTAL_ITEM_WIDTH;
      const newIndex = startX.value + indexDelta;
      // Clamp with some elasticity at edges
      const clampedIndex = Math.max(-0.3, Math.min(actions.length - 0.7, newIndex));
      currentIndex.value = clampedIndex;
    })
    .onEnd((event) => {
      // Determine target index based on velocity and position
      let targetIndex: number;
      
      if (Math.abs(event.velocityX) > 500) {
        // Fast swipe - use velocity direction
        targetIndex = event.velocityX < 0 
          ? Math.ceil(currentIndex.value) 
          : Math.floor(currentIndex.value);
      } else {
        // Slow swipe - snap to nearest
        targetIndex = Math.round(currentIndex.value);
      }
      
      // Clamp to valid range
      targetIndex = Math.max(0, Math.min(targetIndex, actions.length - 1));
      
      // Animate to target
      currentIndex.value = withSpring(targetIndex, { 
        damping: 20, 
        stiffness: 200,
        mass: 0.8,
      });
      
      // Update selection
      runOnJS(handleModeChange)(targetIndex);
    });

  // Handle direct tap on an item
  const handleItemPress = React.useCallback((index: number) => {
    currentIndex.value = withSpring(index, { 
      damping: 20, 
      stiffness: 200,
      mass: 0.8,
    });
    handleModeChange(index);
  }, [handleModeChange]);

  // Calculate offset for centering
  const animatedContainerStyle = useAnimatedStyle(() => {
    const offset = (SCREEN_WIDTH / 2) - (TOTAL_ITEM_WIDTH / 2) - (currentIndex.value * TOTAL_ITEM_WIDTH);
    return {
      transform: [{ translateX: offset }],
    };
  });

  return (
    <View className="w-full overflow-hidden">
      <GestureDetector gesture={panGesture}>
        <Animated.View 
          className="flex-row"
          style={animatedContainerStyle}
        >
          {actions.map((action, index) => (
            <ModeItem
              key={action.id}
              action={action}
              index={index}
              currentIndex={currentIndex}
              onPress={() => handleItemPress(index)}
            />
          ))}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
