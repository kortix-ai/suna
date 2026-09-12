import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { Share2, FolderOpen, Trash2, type LucideIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { View, Alert, Pressable, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface ThreadActionsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onShare?: () => void;
  onFiles?: () => void;
  onDelete?: () => void;
}

interface ActionRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

const ActionRow = React.memo(function ActionRow({
  icon,
  label,
  onPress,
  destructive = false,
}: ActionRowProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textClass = destructive ? 'text-destructive' : 'text-foreground';

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onPress();
      }}
      className="flex-row items-center gap-4 px-6 py-2 active:bg-hover active:opacity-70"
      android_ripple={{
        color: isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.06),
        borderless: false,
      }}
    >
      <View
        className={`w-10 h-10 rounded-2xl items-center justify-center ${destructive ? 'bg-destructive/10' : 'bg-muted'}`}
      >
        <Icon as={icon} size={20} className={textClass} strokeWidth={2} />
      </View>
      <Text
        className={`font-roobert-medium text-base flex-1 ${textClass}`}
      >
        {label}
      </Text>
    </Pressable>
  );
});

export function ThreadActionsDrawer({
  isOpen,
  onClose,
  onShare,
  onFiles,
  onDelete,
}: ThreadActionsDrawerProps) {
  const sheetBg = useSheetBackground();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (isOpen && !wasOpen) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetRef.current?.present();
    } else if (!isOpen && wasOpen) {
      bottomSheetRef.current?.dismiss();
    }
  }, [isOpen]);

  const handleDismiss = React.useCallback(() => {
    onClose();
  }, [onClose]);

  const handleShare = React.useCallback(() => {
    bottomSheetRef.current?.dismiss();
    setTimeout(() => {
      onShare?.();
    }, 100);
  }, [onShare]);

  const handleFiles = React.useCallback(() => {
    bottomSheetRef.current?.dismiss();
    setTimeout(() => {
      onFiles?.();
    }, 100);
  }, [onFiles]);

  const handleDelete = React.useCallback(() => {
    bottomSheetRef.current?.dismiss();
    setTimeout(() => {
      Alert.alert(
        t('threadActions.deleteThread'),
        t('threadActions.deleteConfirm'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('common.delete'),
            style: 'destructive',
            onPress: onDelete,
          },
        ]
      );
    }, 100);
  }, [onDelete, t]);


  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      enableDynamicSizing
      enablePanDownToClose
      onDismiss={handleDismiss}
      backdropComponent={SheetBackdrop}
      backgroundStyle={{
        backgroundColor: sheetBg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      {...Platform.select({
        android: {
          android_keyboardInputMode: 'adjustResize' as const,
        },
      })}
    >
      <BottomSheetView
        style={{
          paddingBottom: Math.max(insets.bottom, 20) + 20,
        }}
      >
        <View className="px-6 pt-2 pb-4">
          <Text className="text-lg font-roobert-semibold text-foreground">
            {t('threadActions.title')}
          </Text>
        </View>

        <View>
          {onShare && (
            <ActionRow
              icon={Share2}
              label={t('threadActions.share')}
              onPress={handleShare}
            />
          )}
          {onFiles && (
            <ActionRow
              icon={FolderOpen}
              label={t('threadActions.files')}
              onPress={handleFiles}
            />
          )}
          {onDelete && (
            <ActionRow
              icon={Trash2}
              label={t('threadActions.delete')}
              onPress={handleDelete}
              destructive
            />
          )}
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}
