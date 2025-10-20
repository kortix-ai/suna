import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import BottomSheet, { BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Share, FolderOpen, Trash2 } from 'lucide-react-native';
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
  onPress: () => void;
  destructive?: boolean;
}

function ActionItem({ icon, label, onPress, destructive = false }: ActionItemProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    console.log('🎯 Thread action:', label);
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
      className="flex-row items-center px-6 py-3.5"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View className={`w-9 h-9 rounded-full items-center justify-center ${destructive ? 'bg-destructive/10' : 'bg-secondary/80'}`}>
        <Icon 
          as={icon} 
          size={17} 
          className={destructive ? 'text-destructive' : 'text-foreground/70'} 
          strokeWidth={2} 
        />
      </View>
      <Text className={`ml-3 text-[15px] font-roobert-medium ${destructive ? 'text-destructive' : 'text-foreground'}`}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

/**
 * ThreadActionsDrawer Component
 * 
 * Clean bottom sheet showing thread actions
 * Matches AgentDrawer design consistency
 * 
 * Actions:
 * - Share thread
 * - Manage files
 * - Delete thread (destructive)
 */
export function ThreadActionsDrawer({
  visible,
  onClose,
  onShare,
  onFiles,
  onDelete,
}: ThreadActionsDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['32%'], []);
  const { colorScheme } = useColorScheme();

  React.useEffect(() => {
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('📳 Thread Actions Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

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

  const handleSheetChange = React.useCallback((index: number) => {
    if (index === -1) {
      onClose();
    }
  }, [onClose]);

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
      }}
      handleIndicatorStyle={{
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 40,
        height: 4,
      }}
    >
      <BottomSheetView>
        {/* Header */}
        <View className="px-6 pt-2 pb-3">
          <Text className="text-lg font-roobert-semibold text-foreground">
            Thread Actions
          </Text>
        </View>

        {/* Actions */}
        <View className="pb-6">
          {onShare && (
            <ActionItem
              icon={Share}
              label="Share Thread"
              onPress={() => handleAction(onShare)}
            />
          )}
          
          {onFiles && (
            <ActionItem
              icon={FolderOpen}
              label="Manage Files"
              onPress={() => handleAction(onFiles)}
            />
          )}
          
          {onDelete && (
            <>
              <View className="my-2 mx-6 border-t border-border/30" />
              <ActionItem
                icon={Trash2}
                label="Delete Thread"
                onPress={() => handleAction(onDelete)}
                destructive
              />
            </>
          )}
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

