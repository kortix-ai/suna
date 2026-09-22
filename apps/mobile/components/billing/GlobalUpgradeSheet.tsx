import React, { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { CheckIcon as Check, CaretRightIcon as ChevronRight, UserPlusIcon as UserPlus, UsersIcon as Users } from '@/lib/icons';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { useLanguage } from '@/contexts';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useAccountState } from '@/lib/billing/hooks';
import { haptics } from '@/lib/haptics';
import { getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { getUpgradeSheetTransition } from '@/lib/billing/upgrade-sheet-lifecycle';
import { getTeamUpgradeOffer } from '@/lib/billing/team-upgrade-offer';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';

/** Opens the upgrade sheet when the root sandbox bootstrap is blocked by billing. */
export function SandboxUpgradeGateListener() {
  const { error } = useSandboxContext();
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);
  const handledError = useRef<Error | null>(null);

  useEffect(() => {
    const gate = getUpgradeGate(error);
    if (!gate || error === handledError.current) return;

    handledError.current = error as Error;
    openUpgradeSheet(gate);
  }, [error, openUpgradeSheet]);

  return null;
}

/**
 * Global native counterpart to the web upgrade modal: the Team offer when a
 * billing gate blocks the user.
 *
 * Layout (apps/mobile/design.md): centred plan name and per-seat price (the
 * Billing hero's type), the gate message, an Includes group, the seat total,
 * then one primary pill to the Plans screen and a Not now pill. A member who
 * cannot manage billing sees an Ask an account owner row instead of the pill.
 */
export function GlobalUpgradeSheet() {
  const { t } = useLanguage();
  const sheetRef = useRef<BottomSheetModal>(null);
  const wasPresentedRef = useRef(false);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { isOpen, accountId, message, closeUpgradeSheet } = useUpgradeSheetStore();
  const { data: accountState } = useAccountState({
    accountId: accountId ?? undefined,
    enabled: isOpen,
  });
  const offer = getTeamUpgradeOffer(accountState);
  const included = [
    `$${offer.pricePerSeat} of usage credit per teammate, every month`,
    'Every model, drawn from one shared team wallet',
    'AI Computers to run code, browsers, and terminals',
    'Spend on compute, LLM, or both, with auto top-up',
    'Auto-prorated as teammates join or leave',
  ];

  useEffect(() => {
    const transition = getUpgradeSheetTransition(isOpen, wasPresentedRef.current);
    if (transition === 'present') {
      wasPresentedRef.current = true;
      const frame = requestAnimationFrame(() => sheetRef.current?.present());
      return () => cancelAnimationFrame(frame);
    }
    if (transition === 'dismiss') {
      wasPresentedRef.current = false;
      sheetRef.current?.dismiss();
    }
  }, [isOpen]);

  const handleDismiss = useCallback(() => {
    wasPresentedRef.current = false;
    closeUpgradeSheet();
  }, [closeUpgradeSheet]);

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
          <Text variant="large">{t('upgrade.teamPlan', 'Kortix Team')}</Text>
          <Text variant="h1" className="mt-1 tabular-nums">
            ${offer.pricePerSeat}
          </Text>
          <Text variant="muted" className="mt-1">
            {t('upgrade.perSeatMonthly', 'per seat / month')}
          </Text>
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

        {offer.hasSeatMath ? (
          <SettingsGroup>
            <SettingsRow
              icon={Users}
              label={t('plans.seats', {
                defaultValue: '{{count}} seats × ${{price}}',
                count: offer.seatCount,
                price: offer.pricePerSeat,
              })}
              value={t('plans.perMonth', { defaultValue: '${{total}} / mo', total: offer.monthlyTotal })}
            />
          </SettingsGroup>
        ) : null}

        <View style={{ gap: 10 }}>
          {offer.canManageBilling ? (
            <Button size="lg" className="justify-between rounded-full" onPress={handleViewPlans}>
              <Text>{t('plans.upgradeTo', { defaultValue: 'Upgrade to {{plan}}', plan: 'Team' })}</Text>
              <Icon as={ChevronRight} size={18} />
            </Button>
          ) : (
            <SettingsGroup>
              <SettingsRow
                icon={UserPlus}
                label={t('upgrade.askOwner', 'Ask an account owner for a seat')}
                multiline
              />
            </SettingsGroup>
          )}
          <Button variant="secondary" size="lg" className="rounded-full" onPress={closeUpgradeSheet}>
            <Text>{t('upgrade.notNow', 'Not now')}</Text>
          </Button>
        </View>
      </BottomSheetScrollView>
    </KortixBottomSheetModal>
  );
}
