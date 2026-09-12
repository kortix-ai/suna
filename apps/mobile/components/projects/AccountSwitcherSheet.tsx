/**
 * AccountSwitcherSheet — the top-left account switcher (web breadcrumb dropdown).
 * Account list (switch) + Account settings · All accounts · New account.
 * Same shared Icon/Avatar + NativeWind styling as AccountMenuSheet.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowUpRight, Check, Plus, Settings } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/kortix/avatar';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import type { KortixAccount } from '@/lib/projects/projects-client';
import { NewAccountSheet } from '@/components/accounts/NewAccountSheet';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface AccountSwitcherSheetProps {
  open: boolean;
  accounts: KortixAccount[];
  selectedAccountId: string | null;
  onSelect: (accountId: string) => void;
  onClose: () => void;
}

export function AccountSwitcherSheet({
  open,
  accounts,
  selectedAccountId,
  onSelect,
  onClose,
}: AccountSwitcherSheetProps) {
  const sheetBg = useSheetBackground();
  const sheetRef = useRef<BottomSheetModal>(null);
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const [showNewAccount, setShowNewAccount] = useState(false);

  const dividerColor = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);

  useEffect(() => {
    if (!open) {
      sheetRef.current?.dismiss();
      return;
    }
    const frame = requestAnimationFrame(() => {
      sheetRef.current?.present();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);


  const go = useCallback((fn: () => void) => {
    sheetRef.current?.dismiss();
    setTimeout(fn, 160);
  }, []);

  const handleNewAccount = useCallback(() => {
    go(() => setShowNewAccount(true));
  }, [go]);

  return (
    <>
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      enablePanDownToClose
      onDismiss={onClose}
      backdropComponent={SheetBackdrop}
      backgroundStyle={{ backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
    >
      <BottomSheetView style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 12 }}>
        <Text className="px-2 pb-1.5 font-roobert-medium text-xs uppercase tracking-wider text-muted-foreground">
          Account
        </Text>

        {accounts.map((account) => {
          const selected = account.account_id === selectedAccountId;
          return (
            <Pressable
              key={account.account_id}
              onPress={() => {
                haptics.selection();
                onSelect(account.account_id);
                sheetRef.current?.dismiss();
              }}
              className="flex-row items-center rounded-lg px-2 py-2 active:opacity-80"
            >
              <Avatar variant="custom" size={28} fallbackText={account.name} />
              <Text className="ml-3 flex-1 font-roobert-medium text-[14px] text-foreground" numberOfLines={1}>
                {account.name}
              </Text>
              {selected && <Icon as={Check} size={16} color={theme.primary} strokeWidth={2.4} />}
            </Pressable>
          );
        })}

        <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 8 }} />

        <ActionRow
          icon={Settings}
          label="Account settings"
          onPress={() => {
            const target = selectedAccountId ?? accounts[0]?.account_id;
            if (target) go(() => router.push(`/accounts/${target}`));
          }}
        />
        <ActionRow
          icon={ArrowUpRight}
          label="All accounts"
          onPress={() => go(() => router.push('/accounts'))}
        />
        <ActionRow icon={Plus} label="New account" onPress={handleNewAccount} />
      </BottomSheetView>
    </BottomSheetModal>

    <NewAccountSheet
      open={showNewAccount}
      onClose={() => setShowNewAccount(false)}
      onCreated={(account) => { setShowNewAccount(false); onSelect(account.account_id); }}
    />
    </>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
}: {
  icon: typeof Settings;
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
