import * as React from 'react';
import { View, Dimensions, Pressable, Platform, ScrollView, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';
import { useLanguage } from '@/contexts';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ITEM_SPACING = 8; // Consistent spacing between items (always the same)
const CONTAINER_PADDING = 16; // Padding on sides
const FADE_WIDTH = 120; // Width of fade gradient on each side
const SPACER_WIDTH = SCREEN_WIDTH / 2; // Spacer width to allow centering

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
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });
  const IconComponent = action.icon;

  return (
    <Pressable 
      onPress={onPress} 
      hitSlop={ANDROID_HIT_SLOP}
      style={{
        marginRight: 0,
        marginLeft: 0,
        padding: 0,
      }}
    >
      <View
        className="py-2.5 px-3 flex-row items-center gap-2"
        style={{
          opacity: isSelected ? 1 : 0.5,
          marginRight: 0,
          marginLeft: 0,
        }}
      >
        <IconComponent 
          size={20}
          className={isSelected ? 'text-primary' : 'text-foreground'}
        />
        <Text 
          className={`text-lg font-medium ${isSelected ? 'text-primary' : 'text-foreground'}`}
        >
          {translatedLabel}
        </Text>
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
  const { colorScheme } = useColorScheme();
  const scrollViewRef = React.useRef<ScrollView>(null);
  const lastHapticIndex = React.useRef(-1);
  const hasInitialized = React.useRef(false);
  const isScrollingProgrammatically = React.useRef(false);

  // Find the index of the selected action
  const selectedIndex = React.useMemo(() => {
    const index = actions.findIndex(a => a.id === selectedActionId);
    return index >= 0 ? index : 0;
  }, [actions, selectedActionId]);

  // Store item positions for scrolling
  const itemPositions = React.useRef<number[]>([]);
  const itemWidths = React.useRef<number[]>([]);

  // Find which item is currently centered based on scroll position
  const getCenteredIndex = React.useCallback((scrollX: number): number => {
    const screenCenter = SCREEN_WIDTH / 2;
    const contentCenter = scrollX + screenCenter;
    
    let nearestIndex = 0;
    let minDistance = Infinity;
    
    for (let i = 0; i < actions.length; i++) {
      if (itemPositions.current[i] !== undefined && itemWidths.current[i] !== undefined) {
        const itemX = itemPositions.current[i];
        const itemWidth = itemWidths.current[i];
        const itemCenter = itemX + (itemWidth / 2);
        const distance = Math.abs(itemCenter - contentCenter);
        
        if (distance < minDistance) {
          minDistance = distance;
          nearestIndex = i;
        }
      }
    }
    
    return nearestIndex;
  }, [actions.length]);

  // Scroll to center the selected item
  const scrollToCenter = React.useCallback((index: number, animated = true) => {
    if (
      itemPositions.current[index] !== undefined && 
      itemWidths.current[index] !== undefined &&
      scrollViewRef.current
    ) {
      const itemX = itemPositions.current[index];
      const itemWidth = itemWidths.current[index];
      const itemCenter = itemX + (itemWidth / 2);
      const screenCenter = SCREEN_WIDTH / 2;
      const scrollOffset = itemCenter - screenCenter;
      
      // Ensure we don't scroll to negative values
      const finalOffset = Math.max(0, scrollOffset);
      
      isScrollingProgrammatically.current = true;
      scrollViewRef.current.scrollTo({ 
        x: finalOffset, 
        animated 
      });
      
      // Reset flag after scroll completes
      setTimeout(() => {
        isScrollingProgrammatically.current = false;
      }, animated ? 300 : 0);
    }
  }, []);

  // Measure items and calculate positions
  const measureItem = React.useCallback((index: number, width: number, x: number) => {
    itemWidths.current[index] = width;
    itemPositions.current[index] = x;
    
    // Initial centering after first item is measured
    if (!hasInitialized.current && index === selectedIndex) {
      hasInitialized.current = true;
      // Use a small delay to ensure layout is complete
      setTimeout(() => {
        scrollToCenter(selectedIndex, false);
      }, 50);
    }
  }, [selectedIndex, scrollToCenter]);

  // Scroll to selected item when it changes (after initial load)
  React.useEffect(() => {
    if (hasInitialized.current) {
      scrollToCenter(selectedIndex, true);
    }
  }, [selectedIndex, scrollToCenter]);

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
    
    // Center the tapped item immediately
    scrollToCenter(index, true);
    
    handleModeChange(index);
  }, [handleModeChange, actions, scrollToCenter]);

  // Handle scroll - update haptics as user scrolls
  const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Ignore programmatic scrolling
    if (isScrollingProgrammatically.current) return;
    
    const scrollX = event.nativeEvent.contentOffset.x;
    const centeredIndex = getCenteredIndex(scrollX);
    
    // Light haptic when centered item changes during scroll
    if (centeredIndex !== lastHapticIndex.current) {
      lastHapticIndex.current = centeredIndex;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [getCenteredIndex]);

  // Handle scroll end - snap to center and select
  const handleScrollEnd = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Ignore programmatic scrolling
    if (isScrollingProgrammatically.current) return;
    
    const scrollX = event.nativeEvent.contentOffset.x;
    const centeredIndex = getCenteredIndex(scrollX);
    
    // Snap to center
    scrollToCenter(centeredIndex, true);
    
    // Select the centered item
    const action = actions[centeredIndex];
    if (action && action.id !== selectedActionId) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onActionPress?.(action.id);
    }
  }, [getCenteredIndex, scrollToCenter, actions, selectedActionId, onActionPress]);

  // Gradient colors for fade effect
  const fadeGradientColors = React.useMemo(
    () =>
      colorScheme === 'dark'
        ? (['rgba(18, 18, 21, 1)', 'rgba(18, 18, 21, 0)'] as const)
        : (['rgba(246, 246, 246, 1)', 'rgba(246, 246, 246, 0)'] as const),
    [colorScheme]
  );

  return (
    <View className="w-full overflow-hidden" style={{ position: 'relative' }}>
      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 0,
        }}
        decelerationRate="fast"
        onScroll={handleScroll}
        onMomentumScrollEnd={handleScrollEnd}
        onScrollEndDrag={handleScrollEnd}
        scrollEventThrottle={16}
      >
        {/* Start spacer - allows first item to center */}
        <View style={{ width: SPACER_WIDTH }} />
        
        {actions.map((action, index) => (
          <View
            key={action.id}
            style={{ 
              marginRight: 0,
              marginLeft: 0,
              padding: 0,
            }}
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
        
        {/* End spacer - allows last item to center */}
        <View style={{ width: SPACER_WIDTH }} />
      </ScrollView>

      {/* Left fade gradient */}
      <LinearGradient
        colors={fadeGradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: FADE_WIDTH,
        }}
        pointerEvents="none"
      />

      {/* Right fade gradient */}
      <LinearGradient
        colors={fadeGradientColors}
        start={{ x: 1, y: 0 }}
        end={{ x: 0, y: 0 }}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: FADE_WIDTH,
        }}
        pointerEvents="none"
      />
    </View>
  );
}
