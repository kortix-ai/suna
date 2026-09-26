/**
 * Upgrade screen — `/welcome`, shown once per user right after sign-up
 * (COR-161). The start screen (`app/index.tsx`) opens it when no account has
 * a project and this user has not seen it (`startDestination`,
 * lib/onboarding/onboarding.ts). Never a paywall: "Continue with Free"
 * always leads on to `/new`.
 *
 * The offer is the upgrade sheet's (`GlobalUpgradeSheet`): Kortix Team and the
 * first four lines of its Includes list (`welcomeOffer`).
 * - iOS (App Store guideline 3.1.1, `lib/billing/store-policy.ts`): plan name
 *   and benefits, no price, no purchase button — Continue with Free only.
 * - Android and web: the per-seat price and a primary Upgrade that opens web
 *   billing (the Plans screen's checkout, `openExternalUrl`); a user who
 *   cannot manage billing sees "Ask an account owner to upgrade" instead.
 * - An account already on a paid plan skips the screen.
 *
 * The seen flag is written as soon as the offer is on screen
 * (`useOnboardingStore`), so a killed app does not show it twice.
 */

import * as React from 'react';
import { Platform, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useAuthContext, useLanguage } from '@/contexts';
import { openExternalUrl } from '@/lib/billing/checkout';
import { useAccountState } from '@/lib/billing/hooks';
import { getPlanFamily } from '@/lib/billing/plan-action';
import { getTeamUpgradeOffer } from '@/lib/billing/team-upgrade-offer';
import { getWebBillingUrl } from '@/lib/billing/web-links';
import { haptics } from '@/lib/haptics';
import { ArrowUpRightIcon, CheckIcon } from '@/lib/icons';
import { welcomeOffer } from '@/lib/onboarding/onboarding';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useOnboardingStore } from '@/stores/onboarding-store';
import { useBootStore } from '@/stores/boot-store';

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const userId = user?.id ?? null;
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const markUpgradeSeen = useOnboardingStore((s) => s.markUpgradeSeen);
  const [opening, setOpening] = React.useState(false);

  const accountState = useAccountState({ accountId: accountId ?? undefined, enabled: !!accountId });
  const teamOffer = getTeamUpgradeOffer(accountState.data);
  const offer = welcomeOffer({
    os: Platform.OS,
    family: getPlanFamily(accountState.data),
    canManageBilling: teamOffer.canManageBilling,
    pricePerSeat: teamOffer.pricePerSeat,
  });
  // A failed plan lookup still shows the offer: the screen is never a dead end.
  const loading = !!accountId && accountState.isLoading;
  const skip = !loading && !offer.show;
  // At launch the native splash covers the plan lookup (KRTX-244): it hides
  // when the offer is ready, and the loader draws only after it is gone.
  const splashHidden = useBootStore((s) => s.splashHidden);
  React.useEffect(() => {
    if (!loading && !skip) useBootStore.getState().settleLanding();
  }, [loading, skip]);

  React.useEffect(() => {
    if (loading || !userId) return;
    markUpgradeSeen(userId);
    // Already on a paid plan: nothing to offer.
    if (skip) router.replace('/new');
  }, [loading, skip, userId, markUpgradeSeen, router]);

  const continueFree = React.useCallback(() => {
    haptics.tap();
    router.replace('/new');
  }, [router]);

  const upgrade = React.useCallback(async () => {
    if (opening) return;
    haptics.medium();
    setOpening(true);
    try {
      // Resolves when the in-app browser closes: then on to the first project.
      await openExternalUrl(getWebBillingUrl());
      router.replace('/new');
    } catch {
      toast.error(t('billing.openWebFailed', 'Could not open kortix.com. Try again.'));
    } finally {
      setOpening(false);
    }
  }, [opening, router, toast, t]);

  if (loading || skip) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 items-center justify-center bg-background">
          {splashHidden ? <KortixLoader size="xlarge" /> : null}
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        className="flex-1 bg-background px-4"
        style={{ paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 16) }}>
        <View className="flex-1 justify-center gap-6">
          <View className="items-center">
            <Text variant="h3">{t('upgrade.teamPlan', 'Kortix Team')}</Text>
            {offer.action === 'none' ? null : (
              <Text variant="muted" className="mt-1 tabular-nums">
                {`$${teamOffer.pricePerSeat} ${t('upgrade.perSeatMonthly', 'per seat / month')}`}
              </Text>
            )}
          </View>

          <SettingsGroup>
            {offer.benefits.map((benefit) => (
              <SettingsRow key={benefit} icon={CheckIcon} label={benefit} multiline />
            ))}
          </SettingsGroup>
        </View>

        <View className="gap-2.5 pt-3">
          {offer.action === 'upgrade' ? (
            <Button size="lg" className="rounded-full" disabled={opening} onPress={upgrade}>
              <Text>{t('plans.upgradeTo', { defaultValue: 'Upgrade to {{plan}}', plan: 'Team' })}</Text>
              <Icon as={ArrowUpRightIcon} size={18} />
            </Button>
          ) : offer.action === 'ask-owner' ? (
            <Text variant="muted" className="py-2 text-center">
              {t('plans.askOwner', 'Ask an account owner to upgrade')}
            </Text>
          ) : null}
          <Button
            size="lg"
            variant={offer.action === 'upgrade' ? 'secondary' : 'default'}
            className="rounded-full"
            disabled={opening}
            onPress={continueFree}>
            <Text>Continue with Free</Text>
          </Button>
        </View>
      </View>
    </>
  );
}
