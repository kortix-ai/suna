import React, { useCallback, useRef } from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { CheckIcon as Check, CaretRightIcon as ChevronRight, UserPlusIcon as UserPlus } from '@/lib/icons';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal, useSheetOpenMove } from '@/components/kortix/sheet';
import { useLanguage } from '@/contexts';
import { useAccountState } from '@/lib/billing/hooks';
import { canManageBilling } from '@/lib/billing/plan-action';
import { haptics } from '@/lib/haptics';
import { canShowExternalPurchase } from '@/lib/billing/store-policy';
import { getUpgradeSheetIncludedItems } from '@/lib/billing/upgrade-sheet-included';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';

/**
 * Global native counterpart to the web upgrade modal: the Credits offer when a
 * billing gate blocks the user.
 *
 * Layout (apps/mobile/design.md): centred plan name, a one-line "pick any
 * monthly amount on the web" pitch, the gate message, an Includes group,
 * then one primary pill to the Plans screen and a Not now pill. A member who
 * cannot manage billing sees an Ask an account owner row instead of the pill.
 *
 * iOS (App Store guideline 3.1.1): the pitch line and the pill to Plans drop
 * out. `canShowExternalPurchase` (`lib/billing/store-policy`) gates both. iOS
 * sees the plan name, the gate message, the Includes group, and Not now only
 * (still an Ask-an-owner row for a member who can't manage billing — that
 * row was never a purchase link).
 */
export function GlobalUpgradeSheet() {
  const { t } = useLanguage();
  const sheetRef = useRef<BottomSheetModal>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { isOpen, accountId, message, closeUpgradeSheet } = useUpgradeSheetStore();
  const { markDismissed } = useSheetOpenMove(sheetRef, isOpen);
  const { data: accountState } = useAccountState({
    accountId: accountId ?? undefined,
    enabled: isOpen,
  });
  const canManage = canManageBilling(accountState);
  const canPurchase = canShowExternalPurchase(Platform.OS);
  const included = getUpgradeSheetIncludedItems();

  const handleDismiss = useCallback(() => {
    markDismissed();
    closeUpgradeSheet();
  }, [markDismissed, closeUpgradeSheet]);

  const handleViewPlans = useCallback(() => {
    haptics.medium();
    closeUpgradeSheet();
    router.push('/plans');
  }, [closeUpgradeSheet, router]);

  return (
    <KortixBottomSheetModal
      ref={sheetRef}
      snapPoints={['88%']}
      enableDynamicSizing={false}
      enablePanDownToClose
      onDismiss={handleDismiss}
>
      <BottomSheetScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: insets.bottom + 20,
          gap: 18,
        }}>
        <View className="items-center">
          <Text variant="large">{t('upgrade.creditsPlan', 'Kortix Credits')}</Text>
          {canPurchase ? (
            <Text variant="muted" className="mt-1 text-center">
              {t(
                'upgrade.pickAmount',
                'Pick any monthly amount on the web. Unlimited members share one credit pool.'
              )}
            </Text>
          ) : null}
          {message ? (
            <Text variant="muted" className="mt-4 text-center">
              {message}
            </Text>
          ) : null}
        </View>

        <SettingsGroup title={t('upgrade.includes', 'Includes')}>
          {included.map((item) => (
            <SettingsRow key={item} icon={Check} label={item} multiline />
          ))}
        </SettingsGroup>

        <View style={{ gap: 10 }}>
          {!canManage ? (
            <SettingsGroup>
              <SettingsRow
                icon={UserPlus}
                label={t('plans.askOwner', 'Ask an account owner to upgrade')}
                multiline
              />
            </SettingsGroup>
          ) : canPurchase ? (
            <Button size="lg" className="justify-between rounded-full" onPress={handleViewPlans}>
              <Text>{t('plans.upgradeTo', { defaultValue: 'Upgrade to {{plan}}', plan: 'Credits' })}</Text>
              <Icon as={ChevronRight} size={18} />
            </Button>
          ) : null}
          <Button variant="secondary" size="lg" className="rounded-full" onPress={closeUpgradeSheet}>
            <Text>{t('upgrade.notNow', 'Not now')}</Text>
          </Button>
        </View>
      </BottomSheetScrollView>
    </KortixBottomSheetModal>
  );
}
