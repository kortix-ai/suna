/**
 * AccountSwitcherSheet — pick the active account/team for the projects list.
 * Mirrors the web app-header account switcher.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View, Pressable } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, Users, User } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
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
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  useEffect(() => {
    if (open) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

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
      <BottomSheetView style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 20 }}>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
          Switch account
        </Text>

        {accounts.map((account) => {
          const selected = account.account_id === selectedAccountId;
          const Icon = account.personal_account ? User : Users;
          return (
            <Pressable
              key={account.account_id}
              onPress={() => {
                haptics.selection();
                onSelect(account.account_id);
                sheetRef.current?.dismiss();
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: selected ? theme.primary : border,
                marginBottom: 8,
              }}
            >
              <Icon size={18} color={muted} style={{ marginRight: 12 }} />
              <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
                {account.name}
              </Text>
              {selected && <Check size={18} color={theme.primary} />}
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheetModal>
  );
}
