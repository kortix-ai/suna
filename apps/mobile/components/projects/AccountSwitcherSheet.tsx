/**
 * AccountSwitcherSheet — pick the active account/team for the projects list.
 * Mirrors the web app-header account switcher. Uses the shared Icon/Avatar +
 * NativeWind components for consistency with the rest of the app.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
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
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

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
        <Text className="mb-3 font-roobert-medium text-xs uppercase tracking-wider text-muted-foreground">
          Switch account
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
              className="mb-2 flex-row items-center rounded-xl px-3 py-2.5 active:opacity-80"
              style={{ borderWidth: 1, borderColor: selected ? theme.primary : border }}
            >
              <Avatar variant="custom" size={32} fallbackText={account.name} />
              <Text className="ml-3 flex-1 font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
                {account.name}
              </Text>
              {selected && <Icon as={Check} size={18} color={theme.primary} strokeWidth={2.4} />}
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheetModal>
  );
}
