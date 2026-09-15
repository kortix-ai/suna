/**
 * Billing page — `/billing`, opened from Account → Workspace → Billing.
 *
 * Layout (apps/mobile/design.md → Billing): a `BillingHero` (gradient, centred
 * header, balance, breakdown, one primary action) on `SettingsPage hero`, then
 * the scheduled plan change and the Subscription group on the page sheet —
 * icon · label · trailing rows, no descriptions.
 *
 * Reads the active account (hooks/useActiveAccount), the same account as the
 * Account page's plan badge. Mobile has no in-app purchase: Buy credits and
 * Manage on kortix.com open web billing in the browser. The balance refetches
 * when the app returns to the foreground and on pull to refresh, so a web
 * purchase shows up on return.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AppState, RefreshControl, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useQueryClient } from '@tanstack/react-query';
import { useColorScheme } from 'nativewind';
import {
  AlertCircle,
  ArrowUpDown,
  BadgeCheck,
  Calendar,
  CreditCard,
  Receipt,
  RotateCcw,
} from 'lucide-react-native';
import { formatCredits } from '@kortix/shared';

import {
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { BillingHero, type BillingHeroRow } from '@/components/billing/BillingHero';
import { PricingTierBadge } from '@/components/billing/PricingTierBadge';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import { useAuthContext, useLanguage } from '@/contexts';
import { useActiveAccount } from '@/hooks/useActiveAccount';
import { billingKeys, useAccountState } from '@/lib/billing';
import { openExternalUrl } from '@/lib/billing/checkout';
import { getWebBillingUrl, getWebCreditsExplainedUrl } from '@/lib/billing/web-links';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import { THEME } from '@/lib/utils/theme';

interface BillingPageProps {
  visible: boolean;
  /** Kept for API compatibility; the header's back button navigates via the router. */
  onClose: () => void;
  /** Opens the Plans screen. */
  onChangePlan?: () => void;
}

const formatDate = (dateValue: string | number, month: 'long' | 'short' = 'long') =>
  // Numbers are Unix timestamps in seconds; strings are ISO dates.
  new Date(typeof dateValue === 'number' ? dateValue * 1000 : dateValue).toLocaleDateString(
    'en-US',
    { year: 'numeric', month, day: 'numeric' }
  );

export function BillingPage({ visible, onChangePlan }: BillingPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const toast = useToast();
  const { colorScheme } = useColorScheme();
  const queryClient = useQueryClient();
  const { account, isLoading: isLoadingAccount } = useActiveAccount();

  const {
    data: accountState,
    error,
    refetch,
  } = useAccountState({
    accountId: account?.account_id ?? undefined,
    // Wait for the account list, so the first request already has the account.
    enabled: visible && !!user && !isLoadingAccount,
  });

  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, refetch]);

  // Back from kortix.com (a purchase, a plan change): show the new balance.
  useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [visible, refetch]);

  const openCreditsExplained = useCallback(async () => {
    haptics.tap();
    try {
      await WebBrowser.openBrowserAsync(getWebCreditsExplainedUrl(), {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (openError) {
      log.error('Error opening credits explained page:', openError);
    }
  }, []);

  const openWebBilling = useCallback(async () => {
    haptics.tap();
    try {
      await openExternalUrl(getWebBillingUrl());
    } catch {
      toast.error(t('billing.openWebFailed', 'Could not open kortix.com. Try again.'));
    }
  }, [t, toast]);

  const changePlan = useCallback(() => {
    haptics.tap();
    onChangePlan?.();
  }, [onChangePlan]);

  if (!visible) return null;

  const title = t('billing.title', 'Billing');
  const helpLabel = t('billing.creditsExplained', 'Credits explained');

  if (error && !accountState) {
    return (
      <View className="flex-1 bg-background">
        <SettingsHeader title={title} />
        <SettingsPage>
          <SettingsGroup>
            <SettingsRow
              icon={AlertCircle}
              label={t('billing.error', 'Failed to load billing information')}
              destructive
            />
            <SettingsRow
              icon={RotateCcw}
              label={t('common.retry', 'Try again')}
              onPress={() => {
                haptics.tap();
                void refetch();
              }}
            />
          </SettingsGroup>
        </SettingsPage>
      </View>
    );
  }

  const loading = !accountState;

  // Credits from AccountState
  const credits = accountState?.credits;
  const dailyRefreshInfo = credits?.daily_refresh;

  // Hours until daily credits refresh, e.g. "in 3h"
  const getDailyRefreshTime = (): string | null => {
    if (!dailyRefreshInfo?.enabled) return null;

    let hours: number;
    if (dailyRefreshInfo.seconds_until_refresh) {
      hours = Math.ceil(dailyRefreshInfo.seconds_until_refresh / 3600);
    } else if (dailyRefreshInfo.next_refresh_at) {
      const diffMs = new Date(dailyRefreshInfo.next_refresh_at).getTime() - Date.now();
      hours = Math.ceil(diffMs / (1000 * 60 * 60));
    } else {
      return null;
    }

    if (hours <= 0 || isNaN(hours)) return null;
    return hours === 1 ? t('billing.in1Hour', 'in 1 hour') : `in ${hours}h`;
  };

  const subscription = accountState?.subscription;
  // The API's trial-aware plan label first, then the stored tier name.
  const planName =
    accountState?.plan?.label ||
    (subscription ? subscription.tier_display_name || subscription.tier_key || 'Basic' : '');
  const nextBillingDate = subscription?.current_period_end
    ? formatDate(subscription.current_period_end)
    : null;
  const dailyRefreshTime = getDailyRefreshTime();
  const commitment = subscription?.commitment;
  const commitmentEndDate =
    commitment?.has_commitment && commitment.commitment_end_date
      ? formatDate(commitment.commitment_end_date, 'short')
      : null;
  const cancellationDate =
    subscription?.is_cancelled && subscription.cancellation_effective_date
      ? formatDate(subscription.cancellation_effective_date, 'short')
      : null;

  const scheduledChange = subscription?.scheduled_change ?? null;
  const canBuyCredits = !!subscription?.can_purchase_credits;

  // Credit breakdown under the balance. Daily credits only exist when daily
  // refresh is enabled; monthly shows unless daily replaces it and is empty.
  const breakdown: BillingHeroRow[] = [
    dailyRefreshInfo?.enabled
      ? { label: t('billing.daily', 'Daily'), value: formatCredits(credits?.daily || 0) }
      : null,
    dailyRefreshTime
      ? { label: t('billing.nextDailyRefresh', 'Next daily refresh'), value: dailyRefreshTime }
      : null,
    !dailyRefreshInfo?.enabled || (credits?.monthly || 0) > 0
      ? { label: t('billing.monthly', 'Monthly'), value: formatCredits(credits?.monthly || 0) }
      : null,
    { label: t('billing.extra', 'Extra'), value: formatCredits(credits?.extra || 0) },
  ].filter((row): row is BillingHeroRow => row !== null);

  // One primary action in the hero: buying credits when the plan allows it,
  // otherwise changing plan. Change plan then moves to the Subscription group.
  const heroAction = canBuyCredits
    ? { label: t('billing.buyCredits', 'Buy credits'), onPress: openWebBilling, external: true }
    : onChangePlan
      ? { label: t('billing.changePlan', 'Change plan'), onPress: changePlan }
      : undefined;
  const showChangePlanRow = canBuyCredits && !!onChangePlan;

  return (
    <View className="flex-1 bg-background">
      <SettingsPage
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colorScheme === 'dark' ? THEME.dark.foreground : THEME.light.foreground}
          />
        }
        hero={
          <BillingHero
            title={title}
            helpLabel={helpLabel}
            onHelp={openCreditsExplained}
            loading={loading}
            balanceLabel={t('billing.totalCredits', 'Total available credits')}
            balance={formatCredits(credits?.total || 0)}
            rows={breakdown}
            action={heroAction}
          />
        }>
        {scheduledChange ? (
          <ScheduledDowngradeCard scheduledChange={scheduledChange} onCancel={() => void refetch()} />
        ) : null}

        {subscription ? (
          <SettingsGroup title={t('billing.subscription', 'Subscription')}>
            <SettingsRow
              icon={BadgeCheck}
              label={t('billing.currentPlan', 'Current plan')}
              right={<PricingTierBadge planName={planName} size="md" />}
            />
            {nextBillingDate ? (
              <SettingsRow
                icon={Calendar}
                label={t('billing.nextBilling', 'Next billing')}
                value={nextBillingDate}
              />
            ) : null}
            {commitmentEndDate ? (
              <SettingsRow
                icon={CreditCard}
                label={t('billing.annualCommitment', 'Annual commitment')}
                value={t('billing.activeUntil', {
                  defaultValue: 'Until {{date}}',
                  date: commitmentEndDate,
                })}
              />
            ) : null}
            {cancellationDate ? (
              <SettingsRow
                icon={AlertCircle}
                label={t('billing.cancelsOn', 'Cancels on')}
                value={cancellationDate}
                destructive
              />
            ) : null}
            {showChangePlanRow ? (
              <SettingsRow
                icon={ArrowUpDown}
                label={t('billing.changePlan', 'Change plan')}
                onPress={changePlan}
              />
            ) : null}
            <SettingsRow
              icon={Receipt}
              label={t('billing.manageOnWeb', 'Manage on kortix.com')}
              external
              onPress={openWebBilling}
            />
          </SettingsGroup>
        ) : null}
      </SettingsPage>
    </View>
  );
}
