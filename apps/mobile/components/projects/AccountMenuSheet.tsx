/**
 * AccountMenuSheet — the top-right account/user menu (web AppHeader parity).
 * Identity + Settings + Sign out. People-are-round: the avatar is a circle.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View, Pressable } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Settings, LogOut, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
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

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const divider = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const avatarBg = isDark ? '#1f1f22' : '#ECECEC';

  useEffect(() => {
    if (open) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
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
      backgroundStyle={{ backgroundColor: getSheetBg(isDark), borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
    >
      <BottomSheetView style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
        {/* Identity */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: avatarBg,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 12,
            }}
          >
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg }}>{initial}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            {!!accountName && (
              <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
                {accountName}
              </Text>
            )}
            {!!email && (
              <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 1 }} numberOfLines={1}>
                {email}
              </Text>
            )}
          </View>
        </View>

        <View style={{ height: 1, backgroundColor: divider, marginVertical: 10 }} />

        <Pressable
          onPress={() => {
            haptics.tap();
            onSettings();
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 12,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Settings size={18} color={fg} />
          <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color: fg, marginLeft: 14 }}>Settings</Text>
          <ChevronRight size={16} color={muted} />
        </Pressable>

        <View style={{ height: 1, backgroundColor: divider, marginVertical: 10 }} />

        <Pressable
          onPress={() => {
            haptics.medium();
            onSignOut();
          }}
          disabled={isSigningOut}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 12,
            opacity: pressed || isSigningOut ? 0.6 : 1,
          })}
        >
          <LogOut size={18} color="#ef4444" />
          <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color: '#ef4444', marginLeft: 14 }}>
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </Text>
        </Pressable>
      </BottomSheetView>
    </BottomSheetModal>
  );
}
