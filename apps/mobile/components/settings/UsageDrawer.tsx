import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import { UsageContent } from './UsageContent';
import { useLanguage } from '@/contexts';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';

interface UsageDrawerProps {
  visible: boolean;
  onClose: () => void;
  onUpgradePress?: () => void;
  onTopUpPress?: () => void;
}

export function UsageDrawer({ visible, onClose, onUpgradePress, onTopUpPress }: UsageDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const snapPoints = React.useMemo(() => ['85%'], []);
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  React.useEffect(() => {
    if (visible && !isOpeningRef.current) {
      isOpeningRef.current = true;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        console.log('📳 [UsageDrawer] Fallback timeout - resetting guard');
        isOpeningRef.current = false;
      }, 500);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('📳 Haptic Feedback: Usage Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else if (!visible) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleClose = React.useCallback(() => {
    console.log('🎯 Usage drawer closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleThreadPress = React.useCallback((threadId: string, projectId: string | null) => {
    console.log('🎯 Thread pressed:', threadId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

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
    console.log('📳 [UsageDrawer] Sheet index changed:', index);
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
        width: 36,
        height: 5,
        borderRadius: 3,
        marginTop: 8,
        marginBottom: 0
      }}
      enableDynamicSizing={false}
      style={{
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden'
      }}
    >
      <BottomSheetScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
      >
        <View className="px-6 pt-4 pb-6 flex-row items-center gap-3">
          <Pressable
            onPress={handleClose}
            className="w-8 h-8 items-center justify-center bg-primary/10 rounded-full p-2"
            hitSlop={8}
          >
            <Icon
              as={X}
              size={24}
              className="text-foreground"
              strokeWidth={2}
            />
          </Pressable>

          <Text className="text-xl font-roobert-medium text-foreground tracking-tight">
            {t('usage.title')}
          </Text>
        </View>

        <UsageContent
          onThreadPress={handleThreadPress}
          onUpgradePress={onUpgradePress}
          onTopUpPress={onTopUpPress}
        />
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

