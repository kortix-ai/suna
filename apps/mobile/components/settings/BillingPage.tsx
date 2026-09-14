/**
 * Billing Page Component
 *
 * Credits balance, credit breakdown, subscription, and purchase actions.
 * Layout (apps/mobile/design.md → Billing): a `BillingHero` (gradient, centred
 * header, balance, breakdown, one primary action) on `SettingsPage hero`, then
 * borderless grouped rows on the page sheet — icon · label · trailing, no
 * descriptions.
 *
 * Rendered by the `/billing` route. The header's back button uses the router
 * (back, or /projects without history), which matches app/billing.tsx.
 */

import React, { useCallback } from 'react';
import { Alert, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Calendar,
  CreditCard,
  RotateCcw,
  Settings,
} from 'lucide-react-native';
import { formatCredits } from '@kortix/shared';

import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { BillingHero, type BillingHeroRow } from '@/components/billing/BillingHero';
import { PricingTierBadge } from '@/components/billing/PricingTierBadge';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import {
  useAccountState,
  useSubscriptionCommitment,
  useScheduledChanges,
  billingKeys,
  presentCustomerInfo,
  shouldUseRevenueCat,
  isRevenueCatInitialized,
  initializeRevenueCat,
} from '@/lib/billing';
import { useAuthContext, useLanguage } from '@/contexts';
import { log } from '@/lib/logger';

interface BillingPageProps {
  visible: boolean;
  /** Kept for API compatibility; the header's back button navigates via the router. */
  onClose: () => void;
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
  const isAuthenticated = !!user;
  const queryClient = useQueryClient();

  const {
    data: accountState,
    isLoading: isLoadingSubscription,
    error: subscriptionError,
    refetch: refetchSubscription,
  } = useAccountState({
    enabled: visible && isAuthenticated,
  });

  const { data: commitmentData, refetch: refetchCommitment } = useSubscriptionCommitment(
    accountState?.subscription?.subscription_id || undefined,
    {
      enabled: visible && !!accountState?.subscription?.subscription_id,
    }
  );

  const { data: scheduledChangesData, refetch: refetchScheduledChanges } = useScheduledChanges({
    enabled: visible && isAuthenticated,
  });

  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();

  const handleSubscriptionUpdate = useCallback(() => {
    refetchSubscription();
    refetchCommitment();
    refetchScheduledChanges();
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
  }, [refetchSubscription, refetchCommitment, refetchScheduledChanges, queryClient]);

  const handleCreditsExplained = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      // Use kortix.com for production, staging.kortix.com for staging
      const baseUrl =
        process.env.EXPO_PUBLIC_ENV === 'staging'
          ? 'https://staging.kortix.com'
          : 'https://www.kortix.com';
      await WebBrowser.openBrowserAsync(`${baseUrl}/credits-explained`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      log.error('Error opening credits explained page:', error);
    }
  }, []);

  const handleChangePlan = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onChangePlan?.();
  }, [onChangePlan]);

  const handleGetCredits = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Use RevenueCat paywall for credit purchases
    if (useNativePaywall) {
      log.log('📱 Using RevenueCat paywall for additional credits');
      await presentUpgradePaywall();
    } else {
      log.warn('⚠️ RevenueCat not available, cannot purchase credits');
    }
  }, [useNativePaywall, presentUpgradePaywall]);

  const handleCustomerInfo = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      // Ensure RevenueCat is initialized before presenting customer info
      if (user && shouldUseRevenueCat()) {
        const initialized = await isRevenueCatInitialized();
        if (!initialized) {
          log.log('🔄 RevenueCat not initialized, initializing now...');
          try {
            await initializeRevenueCat(user.id, user.email || undefined, true);
          } catch (initError) {
            log.warn('⚠️ RevenueCat initialization warning:', initError);
          }
        }
      }

      await presentCustomerInfo();
      // Refresh billing data after user returns from customer info portal
      handleSubscriptionUpdate();
    } catch (error) {
      log.error('Error presenting customer info portal:', error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [user, handleSubscriptionUpdate]);

  const handleRestorePurchase = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert(
      t('billing.restorePurchase', 'Restore purchase'),
      t('billing.noPurchaseToRestore', 'No purchase to be restored'),
      [{ text: t('common.ok', 'OK') }]
    );
  }, [t]);

  // Show RevenueCat actions on iOS/Android only
  const useRevenueCat = shouldUseRevenueCat();

  if (!visible) return null;

  const title = t('billing.title', 'Billing');
  const helpLabel = t('billing.creditsExplained', 'Credits explained');

  if (isLoadingSubscription) {
    return (
      <View className="absolute inset-0 z-50 bg-background">
        <SettingsPage
          hero={
            <BillingHero
              title={title}
              helpLabel={helpLabel}
              onHelp={handleCreditsExplained}
              loading
            />
          }>
          {null}
        </SettingsPage>
      </View>
    );
  }

  if (subscriptionError) {
    return (
      <View className="absolute inset-0 z-50 bg-background">
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
              label={t('common.tryAgain', 'Try again')}
              onPress={() => refetchSubscription()}
            />
          </SettingsGroup>
        </SettingsPage>
      </View>
    );
  }

  // Credits from AccountState
  const credits = accountState?.credits;
  const totalCredits = credits?.total || 0;
  const dailyCredits = credits?.daily || 0;
  const monthlyCredits = credits?.monthly || 0;
  const extraCredits = credits?.extra || 0;
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
  const nextBillingDate = subscription?.current_period_end
    ? formatDate(subscription.current_period_end)
    : null;
  const dailyRefreshTime = getDailyRefreshTime();
  const commitmentEndDate =
    commitmentData?.has_commitment && commitmentData?.commitment_end_date
      ? formatDate(commitmentData.commitment_end_date, 'short')
      : null;
  const cancellationDate =
    subscription?.is_cancelled && subscription.cancellation_effective_date
      ? formatDate(subscription.cancellation_effective_date, 'short')
      : null;

  const scheduledChange = scheduledChangesData?.scheduled_change || subscription?.scheduled_change;
  const canBuyCredits = !!subscription?.can_purchase_credits;

  // Credit breakdown under the balance. Daily credits only exist when daily
  // refresh is enabled; monthly shows unless daily replaces it and is empty.
  const breakdown: BillingHeroRow[] = [
    dailyRefreshInfo?.enabled
      ? { label: t('billing.daily', 'Daily'), value: formatCredits(dailyCredits) }
      : null,
    dailyRefreshTime
      ? { label: t('billing.nextDailyRefresh', 'Next daily refresh'), value: dailyRefreshTime }
      : null,
    !dailyRefreshInfo?.enabled || monthlyCredits > 0
      ? { label: t('billing.monthly', 'Monthly'), value: formatCredits(monthlyCredits) }
      : null,
    { label: t('billing.extra', 'Extra'), value: formatCredits(extraCredits) },
  ].filter((row): row is BillingHeroRow => row !== null);

  // One primary action in the hero: buying credits when the plan allows it,
  // otherwise changing plan. The other action stays on the sheet.
  const heroAction = canBuyCredits
    ? { label: t('billing.getAdditionalCredits', 'Get additional credits'), onPress: handleGetCredits }
    : subscription && onChangePlan
      ? { label: t('billing.changePlan', 'Change plan'), onPress: handleChangePlan }
      : undefined;
  const showChangePlanOnSheet = !!subscription && !!onChangePlan && canBuyCredits;

  return (
    <View className="absolute inset-0 z-50 bg-background">
      <SettingsPage
        hero={
          <BillingHero
            title={title}
            helpLabel={helpLabel}
            onHelp={handleCreditsExplained}
            balanceLabel={t('billing.totalCredits', 'Total available credits')}
            balance={formatCredits(totalCredits)}
            rows={breakdown}
            action={heroAction}
          />
        }>
        {scheduledChange && (
          <ScheduledDowngradeCard
            scheduledChange={scheduledChange}
            onCancel={handleSubscriptionUpdate}
          />
        )}

        {subscription && (
          <View>
            <SettingsGroup title={t('billing.subscription', 'Subscription')}>
              <SettingsRow
                label={t('billing.currentPlan', 'Current plan')}
                right={
                  <PricingTierBadge
                    planName={subscription.tier_display_name || subscription.tier_key || 'Basic'}
                    size="md"
                  />
                }
              />
              {nextBillingDate && (
                <SettingsRow
                  icon={Calendar}
                  label={t('billing.nextBilling', 'Next billing')}
                  value={nextBillingDate}
                />
              )}
              {commitmentEndDate && (
                <SettingsRow
                  icon={CreditCard}
                  label={t('billing.annualCommitment', 'Annual commitment')}
                  value={t('billing.activeUntil', {
                    defaultValue: 'Until {date}',
                    date: commitmentEndDate,
                  })}
                />
              )}
              {cancellationDate && (
                <SettingsRow
                  icon={AlertCircle}
                  label={t('billing.cancelsOn', 'Cancels on')}
                  value={cancellationDate}
                  destructive
                />
              )}
            </SettingsGroup>

            {showChangePlanOnSheet && (
              <Button size="lg" variant="secondary" className="mt-3 rounded-full" onPress={handleChangePlan}>
                <Text>{t('billing.changePlan', 'Change plan')}</Text>
              </Button>
            )}
          </View>
        )}

        {useRevenueCat && (
          <SettingsGroup title={t('billing.purchases', 'Purchases')}>
            <SettingsRow
              icon={Settings}
              label={t('billing.customerInfo', 'Customer info')}
              onPress={handleCustomerInfo}
            />
            <SettingsRow
              icon={RotateCcw}
              label={t('billing.restorePurchase', 'Restore purchase')}
              onPress={handleRestorePurchase}
            />
          </SettingsGroup>
        )}
      </SettingsPage>
    </View>
  );
}
