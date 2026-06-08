/**
 * AccountSwitcherSheet — the top-left account switcher (web breadcrumb dropdown).
 * Account list (switch) + Account settings · All accounts · New account.
 * Same shared Icon/Avatar + NativeWind styling as AccountMenuSheet.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View, Pressable, Alert, Platform, Linking } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowUpRight, Check, Plus, Settings } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
import { useToast } from '@/components/ui/toast-provider';
import { getFrontendUrl } from '@/api/config';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
import { useCreateAccount } from '@/lib/projects/hooks';
import { haptics } from '@/lib/haptics';
import type { KortixAccount } from '@/lib/projects/projects-client';

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
  const sheetRef = useRef<BottomSheetModal>(null);
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const toast = useToast();
  const createAccount = useCreateAccount();

  const dividerColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const frontend = getFrontendUrl().replace(/\/$/, '');

  useEffect(() => {
    if (open) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const go = useCallback((fn: () => void) => {
    sheetRef.current?.dismiss();
    setTimeout(fn, 160);
  }, []);

  const handleNewAccount = useCallback(() => {
    if (Platform.OS !== 'ios') {
      go(() => Linking.openURL(`${frontend}/accounts`).catch(() => {}));
      return;
    }
    Alert.prompt('New account', 'Name your account', async (value) => {
      const name = (value || '').trim();
      if (!name) return;
      try {
        haptics.medium();
        const account = await createAccount.mutateAsync(name);
        onSelect(account.account_id);
        sheetRef.current?.dismiss();
        toast.success('Account created');
      } catch (e: any) {
        toast.error(e?.message || 'Failed to create account');
      }
    });
  }, [createAccount, onSelect, toast, go, frontend]);

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
          onPress={() => go(() => router.push('/(settings)'))}
        />
        <ActionRow
          icon={ArrowUpRight}
          label="All accounts"
          onPress={() => {
            const target = selectedAccountId ?? accounts[0]?.account_id;
            if (target) go(() => router.push(`/accounts/${target}`));
          }}
        />
        <ActionRow icon={Plus} label="New account" onPress={handleNewAccount} />
      </BottomSheetView>
    </BottomSheetModal>
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
