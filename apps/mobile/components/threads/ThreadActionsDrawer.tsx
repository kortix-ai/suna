import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Share, FolderOpen, Trash2, ChevronRight } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ThreadActionsDrawerProps {
  visible: boolean;
  onClose: () => void;
  onShare?: () => void;
  onFiles?: () => void;
  onDelete?: () => void;
}

interface ActionItemProps {
  icon: any;
  label: string;
  subtitle?: string;
  onPress: () => void;
}

/**
 * ActionItem - Matches SelectableListItem design pattern from AgentDrawer
 * Uses exact same visual patterns as SelectableListItem with chevron
 */
function ActionItem({ icon, label, subtitle, onPress }: ActionItemProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      style={animatedStyle}
      className="flex-row items-center justify-between active:opacity-70"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {/* Left: Avatar/Icon + Text - Matching SelectableListItem */}
      <View className="flex-row items-center gap-2 flex-1">
        {/* Icon Container - 48x48 matching avatar size */}
        <View
          style={{
            backgroundColor: colorScheme === 'dark' ? '#232324' : '#f4f4f5',
            width: 48,
            height: 48,
          }}
          className="rounded-xl items-center justify-center"
        >
          <Icon
            as={icon}
            size={20}
            color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'}
            strokeWidth={2}
          />
        </View>

        {/* Text Content - Matching SelectableListItem */}
        <View className="flex-1">
          <Text
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-base font-roobert-medium"
            numberOfLines={1}
          >
            {label}
          </Text>
          {subtitle && (
            <Text
              style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
              className="text-xs font-roobert mt-0.5"
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          )}
        </View>
      </View>

      {/* Right: Chevron - Matching SelectableListItem */}
      <ChevronRight
        size={18}
        color={colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'}
      />
    </AnimatedPressable>
  );
}

/**
 * ThreadActionsDrawer Component
 * 
 * Matches AgentDrawer's design system exactly:
 * - Same BottomSheet configuration
 * - Same layout structure and spacing
 * - Same section header styling
 * - Uses SelectableListItem-style action items
 */
export function ThreadActionsDrawer({
  visible,
  onClose,
  onShare,
  onFiles,
  onDelete,
}: ThreadActionsDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const snapPoints = React.useMemo(() => ['95%'], []);
  const { colorScheme } = useColorScheme();

  const handleSheetChange = React.useCallback((index: number) => {
    console.log('🧵 [ThreadActionsDrawer] Sheet index changed:', index);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (index === -1) {
      isOpeningRef.current = false;
      onClose();
    } else if (index >= 0) {
      isOpeningRef.current = false;
    }
  }, [onClose]);

  React.useEffect(() => {
    if (visible && !isOpeningRef.current) {
      isOpeningRef.current = true;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        console.log('🧵 [ThreadActionsDrawer] Fallback timeout - resetting guard');
        isOpeningRef.current = false;
      }, 500);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetRef.current?.snapToIndex(0);
    } else if (!visible) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleAction = (action: () => void) => {
    action();
  };

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark'
          ? '#161618'
          : '#FFFFFF',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={{
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
    >
      <BottomSheetScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 24,
          paddingBottom: 32,
        }}
      >
        {/* Thread Actions Section - Matching AgentDrawer structure */}
        <View className="pb-3">
          {/* Section Header - Exact AgentDrawer styling */}
          <View className="flex-row items-center justify-between mb-3">
            <Text
              style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
              className="text-sm font-roobert-medium"
            >
              Thread Actions
            </Text>
          </View>

          {/* Action Items - More spacing between items */}
          <View className="gap-4">
            {onShare && (
              <ActionItem
                icon={Share}
                label="Share Thread"
                subtitle="Create a public link"
                onPress={() => handleAction(onShare)}
              />
            )}

            {onFiles && (
              <ActionItem
                icon={FolderOpen}
                label="Manage Files"
                subtitle="View and manage attachments"
                onPress={() => handleAction(onFiles)}
              />
            )}

            {onDelete && (
              <ActionItem
                icon={Trash2}
                label="Delete Thread"
                subtitle="Permanently delete this conversation"
                onPress={() => handleAction(onDelete)}
              />
            )}
          </View>
        </View>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

