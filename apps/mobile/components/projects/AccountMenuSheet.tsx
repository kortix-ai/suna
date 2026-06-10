/**
 * AccountMenuSheet — the top-right account/user menu, mirroring web's user-menu.tsx.
 *
 * Identity → current account (+ account settings) → Home / Docs / Support /
 * User settings → Theme → Log out. Uses the shared Icon + NativeWind components
 * (same conventions as UserMenuSheet). People-are-round; the account is square.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BookOpen, CreditCard, Download, Home, LifeBuoy, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
import { getFrontendUrl } from '@/api/config';
import { getSheetBg, getToggleTrackBg, getToggleActiveBg } from '@/lib/theme-colors';
import { useThemeStore, type ThemePreference } from '@/stores/theme-store';
import { haptics } from '@/lib/haptics';

const THEME_OPTIONS: { value: ThemePreference; icon: typeof Sun }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

interface AccountMenuSheetProps {
  open: boolean;
  name?: string | null;
  email?: string | null;
  accountName?: string | null;
  accountId?: string | null;
  isSigningOut?: boolean;
  onSignOut: () => void;
  onClose: () => void;
}

export function AccountMenuSheet({
  open,
  name,
  email,
  accountName,
  accountId,
  isSigningOut,
  onSignOut,
  onClose,
}: AccountMenuSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const dividerColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);

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

  // Close the sheet first, then run the action (avoids navigating mid-animation).
  const go = useCallback((fn: () => void) => {
    sheetRef.current?.dismiss();
    setTimeout(fn, 160);
  }, []);

  const displayName = (name || email?.split('@')[0] || 'Account').trim();
  const initial = (displayName[0] || '?').toUpperCase();
  const frontend = getFrontendUrl().replace(/\/$/, '');

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
      <BottomSheetView style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 12 }}>
        {/* Identity (person → round) */}
        <View className="flex-row items-center px-1 py-2">
          <View
            className="h-10 w-10 items-center justify-center rounded-full mr-3"
            style={{ backgroundColor: isDark ? '#1f1f22' : '#ECECEC' }}
          >
            <Text className="font-roobert-semibold text-[16px] text-foreground">{initial}</Text>
          </View>
          <View className="flex-1">
            <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
              {displayName}
            </Text>
            {!!email && (
              <Text className="mt-0.5 font-roobert text-xs text-muted-foreground" numberOfLines={1}>
                {email}
              </Text>
            )}
          </View>
        </View>

        <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 6 }} />

        {/* Current account (thing → square) + shortcut to its settings */}
        {!!accountName && (
          <>
            <Pressable
              onPress={() => {
                haptics.tap();
                go(() => router.push(accountId ? `/accounts/${accountId}` : '/(settings)'));
              }}
              className="active:opacity-80"
            >
              <View className="flex-row items-center px-1 py-2.5">
                <Avatar variant="custom" size={32} fallbackText={accountName} />
                <View className="ml-3 flex-1">
                  <Text className="font-roobert-medium text-[14px] text-foreground" numberOfLines={1}>
                    {accountName}
                  </Text>
                  <Text className="mt-0.5 font-roobert text-xs text-muted-foreground" numberOfLines={1}>
                    Account settings
                  </Text>
                </View>
                <Icon as={Settings} size={15} className="text-muted-foreground/70" strokeWidth={2.2} />
              </View>
            </Pressable>
            <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 6 }} />
          </>
        )}

        {/* Actions — same order as web's user-menu.tsx */}
        <ActionRow icon={Home} label="Home" onPress={() => go(() => router.replace('/home'))} />
        <ActionRow icon={BookOpen} label="Docs" onPress={() => go(() => Linking.openURL(`${frontend}/docs`).catch(() => {}))} />
        <ActionRow icon={Download} label="Download apps" onPress={() => go(() => Linking.openURL(`${frontend}/download`).catch(() => {}))} />
        <ActionRow icon={LifeBuoy} label="Support" onPress={() => go(() => Linking.openURL(`${frontend}/support`).catch(() => {}))} />
        <ActionRow icon={Settings} label="User settings" onPress={() => go(() => router.push('/(settings)'))} />
        {/* Billing lives on the web (mobile settings hides Plan/Billing/Usage) —
            open the account's billing tab in the browser, like web's menu does in-app. */}
        {!!accountId && (
          <ActionRow
            icon={CreditCard}
            label="Billing"
            onPress={() => go(() => Linking.openURL(`${frontend}/accounts/${accountId}?tab=billing`).catch(() => {}))}
          />
        )}

        {/* Theme */}
        <View className="flex-row items-center justify-between px-2 py-1.5">
          <Text className="font-roobert-medium text-[14px] text-foreground/85">Theme</Text>
          <View className="flex-row items-center rounded-full p-0.5" style={{ backgroundColor: getToggleTrackBg(isDark) }}>
            {THEME_OPTIONS.map((opt) => {
              const active = preference === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    haptics.selection();
                    void setPreference(opt.value);
                  }}
                  className="h-7 w-9 items-center justify-center rounded-full"
                  style={{ backgroundColor: active ? getToggleActiveBg(isDark) : 'transparent' }}
                >
                  <Icon
                    as={opt.icon}
                    size={14}
                    className={active ? 'text-foreground' : 'text-muted-foreground'}
                    strokeWidth={2.2}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 6 }} />

        {/* Log out */}
        <Pressable
          onPress={() => {
            haptics.medium();
            onSignOut();
          }}
          disabled={isSigningOut}
          className="active:opacity-80"
        >
          <View className="flex-row items-center px-2 py-2.5">
            <Icon as={LogOut} size={16} className="text-destructive" strokeWidth={2.2} />
            <Text
              className="ml-3 font-roobert-medium text-[14px] text-destructive"
              style={{ opacity: isSigningOut ? 0.6 : 1 }}
            >
              {isSigningOut ? 'Signing out…' : 'Log out'}
            </Text>
          </View>
        </Pressable>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
}: {
  icon: typeof Home;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      className="active:opacity-80"
    >
      <View className="flex-row items-center px-2 py-2.5">
        <Icon as={icon} size={16} className="text-muted-foreground" strokeWidth={2.2} />
        <Text className="ml-3 flex-1 font-roobert-medium text-[14px] text-foreground">{label}</Text>
      </View>
    </Pressable>
  );
}
