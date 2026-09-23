/**
 * Billing page — `/billing`, opened from the account screen's Billing row
 * (`/accounts/[id]`) and from a session's out-of-credits banner.
 *
 * A plain settings page (apps/mobile/design.md → Billing; Jay, 2026-09-24 —
 * the gradient hero read as sloppy): the balance and the plan name on the page
 * background, one primary pill, then three groups — Credits (the breakdown),
 * Plan (the subscription), Help. Label · value rows, no icons.
 *
 * Reads the account passed as `accountId` (the account the user opened), else
 * the active account (hooks/useActiveAccount). Mobile has no in-app purchase:
 * Buy credits and Manage on kortix.com open web billing in the browser. The
 * balance refetches when the app returns to the foreground and on pull to
 * refresh, so a web purchase shows up on return.
 *
 * iOS (App Store guideline 3.1.1 — no link to purchase outside IAP): Buy
 * credits, Change plan, and Manage on kortix.com are hidden. iOS shows
 * balance, plan, and the read-only subscription rows only.
 * `canShowExternalPurchase` (`lib/billing/store-policy`) gates all three.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, RefreshControl, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useQueryClient } from '@tanstack/react-query';
import { useColorScheme } from 'nativewind';
import {
  WarningCircleIcon as AlertCircle,
  ArrowUpRightIcon as ArrowUpRight,
  CaretRightIcon as ChevronRight,
  ArrowCounterClockwiseIcon as RotateCcw,
} from '@/lib/icons';
import { formatCredits } from '@kortix/shared';

import {
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { useToast } from '@/components/kortix/toast-provider';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useAuthContext, useLanguage } from '@/contexts';
import { useActiveAccount } from '@/hooks/useActiveAccount';
import { billingKeys, useAccountState } from '@/lib/billing';
import { openExternalUrl } from '@/lib/billing/checkout';
import { canShowExternalPurchase } from '@/lib/billing/store-policy';
import { getWebBillingUrl, getWebCreditsExplainedUrl } from '@/lib/billing/web-links';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import { THEME } from '@/lib/utils/theme';

interface BillingPageProps {
  visible: boolean;
  /** The account to show. Omit for the active account. */
  accountId?: string;
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

export function BillingPage({ visible, accountId, onChangePlan }: BillingPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const toast = useToast();
  const { colorScheme } = useColorScheme();
  const queryClient = useQueryClient();
  const { account, isLoading: isLoadingAccount } = useActiveAccount();
  const targetAccountId = accountId ?? account?.account_id ?? undefined;

  const {
    data: accountState,
    error,
    refetch,
  } = useAccountState({
    accountId: targetAccountId,
    // Wait for the account list, so the first request already has the account.
    enabled: visible && !!user && (!!accountId || !isLoadingAccount),
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

  if (!accountState) {
    return (
      <View className="flex-1 bg-background">
        <SettingsHeader title={title} />
        <View className="flex-1 items-center justify-center">
          <KortixLoader />
        </View>
      </View>
    );
  }

  const credits = accountState.credits;
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

  const subscription = accountState.subscription;
  // The API's trial-aware plan family: Free, Team or Enterprise. Legacy tier
  // names are not shown (Jay, 2026-09-23).
  const planName = accountState.plan?.label ?? '';
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
  // iOS (App Store guideline 3.1.1): no external-purchase action, so Buy
  // credits / Change plan / Manage on kortix.com never render there.
  const canPurchase = canShowExternalPurchase(Platform.OS);
  const canBuyCredits = canPurchase && !!subscription?.can_purchase_credits;

  // One primary pill under the balance: buying credits when the plan allows
  // it, otherwise changing plan. Change plan then moves to the Plan group.
  // iOS gets neither — both open web checkout (App Store guideline 3.1.1).
  const primaryAction = canBuyCredits
    ? { label: t('billing.buyCredits', 'Buy credits'), onPress: openWebBilling, external: true }
    : canPurchase && onChangePlan
      ? { label: t('billing.changePlan', 'Change plan'), onPress: changePlan, external: false }
      : null;
  const showChangePlanRow = canBuyCredits && !!onChangePlan;

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={title} />
      <SettingsPage
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colorScheme === 'dark' ? THEME.dark.foreground : THEME.light.foreground}
          />
        }
        header={
          <View className="items-center gap-1 pb-2 pt-4">
            <Text variant="muted">{t('billing.availableCredits', 'Available credits')}</Text>
            <Text variant="h1" className="tabular-nums">
              {formatCredits(credits?.total || 0)}
            </Text>
            {planName ? (
              <Text variant="muted">
                {t('billing.planName', { defaultValue: '{{plan}} plan', plan: planName })}
              </Text>
            ) : null}
            {primaryAction ? (
              <Button
                size="lg"
                className="mt-5 self-stretch rounded-full"
                onPress={primaryAction.onPress}>
                <Text>{primaryAction.label}</Text>
                <Icon as={primaryAction.external ? ArrowUpRight : ChevronRight} size={18} />
              </Button>
            ) : null}
          </View>
        }>
        <SettingsGroup title={t('billing.credits', 'Credits')}>
          {dailyRefreshInfo?.enabled ? (
            <SettingsRow
              label={t('billing.daily', 'Daily')}
              value={
                dailyRefreshTime
                  ? `${formatCredits(credits?.daily || 0)} · ${t('billing.refreshes', 'refreshes')} ${dailyRefreshTime}`
                  : formatCredits(credits?.daily || 0)
              }
            />
          ) : null}
          {!dailyRefreshInfo?.enabled || (credits?.monthly || 0) > 0 ? (
            <SettingsRow
              label={t('billing.monthly', 'Monthly')}
              value={formatCredits(credits?.monthly || 0)}
            />
          ) : null}
          <SettingsRow label={t('billing.extra', 'Extra')} value={formatCredits(credits?.extra || 0)} />
        </SettingsGroup>

        {scheduledChange ? (
          <ScheduledDowngradeCard scheduledChange={scheduledChange} onCancel={() => void refetch()} />
        ) : null}

        {subscription ? (
          <SettingsGroup title={t('billing.plan', 'Plan')}>
            {planName ? <SettingsRow label={t('billing.currentPlan', 'Current plan')} value={planName} /> : null}
            {nextBillingDate ? (
              <SettingsRow label={t('billing.nextBilling', 'Next billing')} value={nextBillingDate} />
            ) : null}
            {commitmentEndDate ? (
              <SettingsRow
                label={t('billing.annualCommitment', 'Annual commitment')}
                value={t('billing.activeUntil', {
                  defaultValue: 'Until {{date}}',
                  date: commitmentEndDate,
                })}
              />
            ) : null}
            {cancellationDate ? (
              <SettingsRow label={t('billing.cancelsOn', 'Cancels on')} value={cancellationDate} destructive />
            ) : null}
            {showChangePlanRow ? (
              <SettingsRow label={t('billing.changePlan', 'Change plan')} onPress={changePlan} />
            ) : null}
            {canPurchase ? (
              <SettingsRow
                label={t('billing.manageOnWeb', 'Manage on kortix.com')}
                external
                onPress={openWebBilling}
              />
            ) : null}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          <SettingsRow
            label={t('billing.creditsExplained', 'Credits explained')}
            external
            onPress={openCreditsExplained}
          />
        </SettingsGroup>
      </SettingsPage>
    </View>
  );
}
