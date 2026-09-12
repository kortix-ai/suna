import * as React from 'react';
import { View, Platform } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import * as Haptics from 'expo-haptics';
import { UsageContent } from './UsageContent';
import { useLanguage } from '@/contexts';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { log } from '@/lib/logger';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';

interface UsageDrawerProps {
  visible: boolean;
  onClose: () => void;
  onUpgradePress?: () => void;
  onThreadPress?: (threadId: string, projectId: string | null) => void;
}

export function UsageDrawer({ visible, onClose, onUpgradePress, onThreadPress }: UsageDrawerProps) {
  const sheetBg = useSheetBackground();
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapPoints = React.useMemo(() => ['85%'], []);
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  React.useEffect(() => {
    if (visible && !isOpeningRef.current) {
      isOpeningRef.current = true;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        log.log('📳 [UsageDrawer] Fallback timeout - resetting guard');
        isOpeningRef.current = false;
      }, 500);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      log.log('📳 Haptic Feedback: Usage Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else if (!visible) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleClose = React.useCallback(() => {
    log.log('🎯 Usage drawer closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleThreadPress = React.useCallback((threadId: string, projectId: string | null) => {
    log.log('🎯 Thread pressed from UsageDrawer:', threadId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    onThreadPress?.(threadId, projectId);
  }, [onClose, onThreadPress]);


  const handleSheetChange = React.useCallback((index: number) => {
    log.log('📳 [UsageDrawer] Sheet index changed:', index);
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
      backdropComponent={SheetBackdrop}
      backgroundStyle={{
        backgroundColor: sheetBg
      }}
      handleIndicatorStyle={sheetHandleIndicatorStyle(colorScheme === 'dark')}
      enableDynamicSizing={false}
      style={{
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden',
        zIndex: 50,
        elevation: Platform.OS === 'android' ? 10 : undefined,
      }}
    >
      <BottomSheetScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
      >
        <View className="px-6 pt-4 pb-6 flex-row items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onPress={handleClose}
            className="h-8 w-8 rounded-full"
          >
            <Icon
              as={X}
              size={24}
              className="text-foreground"
              strokeWidth={2}
            />
          </Button>

          <Text className="text-xl font-roobert-medium text-foreground tracking-tight">
            {t('usage.title')}
          </Text>
        </View>

        <UsageContent
          onThreadPress={handleThreadPress}
          onUpgradePress={onUpgradePress}
        />
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

