/**
 * AccountMenuSheet — the top-right account/user menu (web AppHeader parity).
 * Identity + Settings + Sign out. Follows the UserMenuSheet conventions
 * (shared Icon component + NativeWind classes). People-are-round: round avatar.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View, Pressable } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Settings, LogOut, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { getSheetBg } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';

interface AccountMenuSheetProps {
  open: boolean;
  email?: string | null;
  accountName?: string | null;
  isSigningOut?: boolean;
  onSettings: () => void;
  onSignOut: () => void;
  onClose: () => void;
}

export function AccountMenuSheet({
  open,
  email,
  accountName,
  isSigningOut,
  onSettings,
  onSignOut,
  onClose,
}: AccountMenuSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const dividerColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  useEffect(() => {
    if (open) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.4} />
    ),
    [],
  );

  const initial = (email?.trim()?.[0] || '?').toUpperCase();

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      enablePanDownToClose
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
      backgroundStyle={{ backgroundColor: getSheetBg(isDark), borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
    >
      <BottomSheetView style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
        {/* Identity */}
        <View className="flex-row items-center py-2">
          <View
            className="h-11 w-11 items-center justify-center rounded-full mr-3"
            style={{ backgroundColor: isDark ? '#1f1f22' : '#ECECEC' }}
          >
            <Text className="font-roobert-semibold text-[18px] text-foreground">{initial}</Text>
          </View>
          <View className="flex-1">
            {!!accountName && (
              <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
                {accountName}
              </Text>
            )}
            {!!email && (
              <Text className="mt-0.5 font-roobert text-xs text-muted-foreground" numberOfLines={1}>
                {email}
              </Text>
            )}
          </View>
        </View>

        <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 12 }} />

        {/* Settings */}
        <Pressable
          onPress={() => {
            haptics.tap();
            onSettings();
          }}
          className="active:opacity-85"
        >
          <View className="flex-row items-center py-3.5">
            <Icon as={Settings} size={18} className="text-foreground/80" strokeWidth={2.2} />
            <View className="ml-4 flex-1">
              <Text className="font-roobert-medium text-[15px] text-foreground">Settings</Text>
            </View>
            <Icon as={ChevronRight} size={16} className="text-muted-foreground/50" strokeWidth={2.2} />
          </View>
        </Pressable>

        <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 12 }} />

        {/* Sign out */}
        <Pressable
          onPress={() => {
            haptics.medium();
            onSignOut();
          }}
          disabled={isSigningOut}
          className="active:opacity-85"
        >
          <View className="flex-row items-center py-3.5">
            <Icon as={LogOut} size={18} className="text-destructive" strokeWidth={2.2} />
            <Text
              className="ml-4 font-roobert-medium text-[15px] text-destructive"
              style={{ opacity: isSigningOut ? 0.6 : 1 }}
            >
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </Text>
          </View>
        </Pressable>
      </BottomSheetView>
    </BottomSheetModal>
  );
}
