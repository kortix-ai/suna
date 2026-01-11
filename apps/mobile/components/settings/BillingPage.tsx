/**
 * Billing Page Component
 *
 * Matches web's "Billing Status – Manage your credits and subscription" design
 */

import React, { useState, useCallback, useEffect } from 'react';
import { View, ScrollView, Pressable, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SettingsHeader } from './SettingsHeader';
import { PricingTierBadge } from '@/components/billing/PricingTierBadge';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import {
  useAccountState,
  accountStateSelectors,
  useSubscriptionCommitment,
  useScheduledChanges,
  billingKeys,
  presentCustomerInfo,
  shouldUseRevenueCat,
  isRevenueCatInitialized,
  initializeRevenueCat,
} from '@/lib/billing';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import {
  ShoppingCart,
  Lightbulb,
  Clock,
  Infinity,
  Calendar,
  CreditCard,
  AlertCircle,
  ArrowRight,
  Settings,
} from 'lucide-react-native';
import { formatCredits } from '@agentpress/shared';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

interface BillingPageProps {
  visible: boolean;
  onClose: () => void;
  onChangePlan?: () => void;
}

export function BillingPage({ visible, onClose, onChangePlan }: BillingPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const isAuthenticated = !!user;
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const {
    data: accountState,
    isLoading: isLoadingSubscription,
    error: subscriptionError,
    refetch: refetchSubscription,
  } = useAccountState({
    enabled: visible && isAuthenticated,
  });

  const {
    data: commitmentData,
    refetch: refetchCommitment,
  } = useSubscriptionCommitment(accountState?.subscription?.subscription_id || undefined, {
    enabled: visible && !!accountState?.subscription?.subscription_id,
  });

  const {
    data: scheduledChangesData,
    refetch: refetchScheduledChanges,
  } = useScheduledChanges({
    enabled: visible && isAuthenticated,
  });

  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleSubscriptionUpdate = useCallback(() => {
    refetchSubscription();
    refetchCommitment();
    refetchScheduledChanges();
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
  }, [refetchSubscription, refetchCommitment, refetchScheduledChanges, queryClient]);


  const handleCreditsExplained = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      // Use kortix.com for production, staging.suna.so for staging
      const baseUrl = process.env.EXPO_PUBLIC_ENV === 'staging'
        ? 'https://staging.suna.so'
        : 'https://www.kortix.com';
      await WebBrowser.openBrowserAsync(`${baseUrl}/credits-explained`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      log.error('Error opening credits explained page:', error);
    }
  }, []);

  const creditsButtonScale = useSharedValue(1);
  const creditsLinkScale = useSharedValue(1);
  const changePlanButtonScale = useSharedValue(1);
  const customerInfoButtonScale = useSharedValue(1);

  const creditsButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsButtonScale.value }],
  }));

  const creditsLinkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsLinkScale.value }],
  }));

  const changePlanButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: changePlanButtonScale.value }],
  }));

  const customerInfoButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: customerInfoButtonScale.value }],
  }));

  const handleChangePlan = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onChangePlan?.();
  }, [onChangePlan]);

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

  // Show button if RevenueCat should be used (iOS/Android only)
  const useRevenueCat = shouldUseRevenueCat();

  // Debug logging to help diagnose button visibility

  if (!visible) return null;

  if (isLoadingSubscription) {
    return (
      <View className="absolute inset-0 z-50 bg-background">
        <SettingsHeader
          title={t('billing.billingStatus', 'Billing Status')}
          onClose={handleClose}
        />
        <View className="p-6">
          <Text className="text-muted-foreground">{t('billing.loading', 'Loading billing information...')}</Text>
        </View>
      </View>
    );
  }

  if (subscriptionError) {
    return (
      <View className="absolute inset-0 z-50 bg-background">
        <SettingsHeader
          title={t('billing.billingStatus', 'Billing Status')}
          onClose={handleClose}
        />
        <View className="p-6">
          <View className="bg-destructive/10 border border-destructive/20 rounded-[18px] p-4">
            <View className="flex-row items-start gap-2">
              <Icon as={AlertCircle} size={16} className="text-destructive" strokeWidth={2} />
              <Text className="text-sm font-roobert-medium text-destructive flex-1">
                {subscriptionError instanceof Error ? subscriptionError.message : t('billing.error', 'Failed to load billing information')}
              </Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  // Get credits from AccountState
  const credits = accountState?.credits;
  const totalCredits = credits?.total || 0;
  const dailyCredits = credits?.daily || 0;
  const monthlyCredits = credits?.monthly || 0;
  const extraCredits = credits?.extra || 0;
  const dailyRefreshInfo = credits?.daily_refresh;

  // Calculate refresh time for daily credits
  const getDailyRefreshTime = (): string | null => {
    if (!dailyRefreshInfo?.enabled) return null;

    let hours: number;
    let seconds: number | undefined;

    if (dailyRefreshInfo.seconds_until_refresh) {
      seconds = dailyRefreshInfo.seconds_until_refresh;
      hours = Math.ceil(seconds / 3600);
    } else if (dailyRefreshInfo.next_refresh_at) {
      const nextRefresh = new Date(dailyRefreshInfo.next_refresh_at);
      const now = new Date();
      const diffMs = nextRefresh.getTime() - now.getTime();
      seconds = Math.floor(diffMs / 1000);
      hours = Math.ceil(diffMs / (1000 * 60 * 60));
    } else {
      log.log('⚠️ No refresh info available:', dailyRefreshInfo);
      return null; // No refresh info available
    }

    // Debug logging
    log.log('🕐 Daily refresh calculation:', {
      seconds_until_refresh: dailyRefreshInfo.seconds_until_refresh,
      next_refresh_at: dailyRefreshInfo.next_refresh_at,
      calculatedSeconds: seconds,
      calculatedHours: hours,
    });

    // Handle edge cases
    if (hours <= 0 || isNaN(hours)) {
      log.log('⚠️ Invalid hours:', hours);
      return null; // Invalid or past refresh time
    }

    if (hours === 1) {
      return t('billing.refreshIn1Hour', 'Refresh in 1 hour');
    }

    // Show actual hours
    return `Refresh in ${hours}h`;
  };

  // Calculate refresh time for monthly credits
  const getMonthlyRefreshTime = (): string | null => {
    // Monthly credits always show next billing date, NOT refresh time
    // Even if daily refresh is enabled, monthly credits renew on billing cycle
    if (nextBillingDate) {
      return `Renews ${nextBillingDate}`;
    }
    return null;
  };

  // Calculate next billing date - matches frontend formatDateFlexible
  const getNextBillingDate = (): string | null => {
    if (!accountState?.subscription?.current_period_end) return null;

    const formatDateFlexible = (dateValue: string | number): string => {
      if (typeof dateValue === 'number') {
        // Unix timestamp in seconds - convert to milliseconds
        return new Date(dateValue * 1000).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
      }
      // ISO string
      return new Date(dateValue).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    };

    return formatDateFlexible(accountState.subscription.current_period_end);
  };

  const nextBillingDate = getNextBillingDate();

  const dailyRefreshTime = getDailyRefreshTime();
  const monthlyRefreshTime = getMonthlyRefreshTime();
  const hasCommitment = commitmentData?.has_commitment;
  const commitmentEndDate = commitmentData?.commitment_end_date
    ? new Date(commitmentData.commitment_end_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  const scheduledChange = scheduledChangesData?.scheduled_change || accountState?.subscription?.scheduled_change;
  const subscription = accountState?.subscription;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: insets.bottom + 24,
          }}
        >
        <SettingsHeader
            title={t('billing.billingStatus', 'Billing Status')}
          onClose={handleClose}
        />

          {/* Subtitle */}
          <AnimatedView
            entering={FadeIn.duration(400).delay(100)}
            className="px-6 mb-6"
          >
            <Text className="text-sm text-muted-foreground">
              {t('billing.manageCredits', 'Manage your credits and subscription')}
            </Text>
          </AnimatedView>

          {/* Scheduled Downgrade Alert */}
          {scheduledChange && (
            <AnimatedView
              entering={FadeIn.duration(400).delay(150)}
              className="px-6 mb-6"
            >
              <ScheduledDowngradeCard
                scheduledChange={scheduledChange}
                onCancel={handleSubscriptionUpdate}
              />
            </AnimatedView>
          )}

          {/* Total Available Credits Card */}
          <AnimatedView
            entering={FadeIn.duration(400).delay(200)}
            className="px-6 mb-6"
          >
            <View className="bg-card border border-border rounded-[18px] p-6">
              <Text className="text-sm font-roobert-medium text-muted-foreground mb-4 uppercase tracking-wider">
                {t('billing.totalCredits', 'Total Available Credits')}
              </Text>
              <Text className="text-[48px] font-roobert-semibold text-foreground leading-none mb-2">
                {formatCredits(totalCredits)}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t('billing.allCredits', 'All credits')}
              </Text>
            </View>
          </AnimatedView>

          {/* Credit Breakdown */}
          <AnimatedView
            entering={FadeIn.duration(400).delay(300)}
            className="px-6 mb-6"
          >
            <View className="gap-3">
              {/* Daily Credits - Only show if daily refresh is enabled */}
              {dailyRefreshInfo?.enabled && (
                <View className="bg-card border border-blue-500/20 rounded-[18px] p-5">
                  <View className="flex-row items-center gap-2 mb-3">
                    <View className="w-8 h-8 rounded-full bg-blue-500/10 items-center justify-center">
                      <Icon as={Clock} size={16} className="text-blue-500" strokeWidth={2} />
                    </View>
                    <Text className="text-xs font-roobert-medium text-muted-foreground uppercase">
                      {t('billing.daily', 'Daily')}
                    </Text>
                  </View>
                  <Text className="text-2xl font-roobert-semibold text-foreground mb-1">
                    {formatCredits(dailyCredits)}
                  </Text>
                  {dailyRefreshTime && (
                    <Text className="text-xs font-roobert-medium text-blue-500">
                      {dailyRefreshTime}
                    </Text>
                  )}
                </View>
              )}

              {/* Monthly Credits */}
              {(!dailyRefreshInfo?.enabled || monthlyCredits > 0) && (
                <View className="bg-card border border-orange-500/20 rounded-[18px] p-5">
                  <View className="flex-row items-center gap-2 mb-3">
                    <View className="w-8 h-8 rounded-full bg-orange-500/10 items-center justify-center">
                      <Icon as={Clock} size={16} className="text-orange-500" strokeWidth={2} />
                    </View>
                    <Text className="text-xs font-roobert-medium text-muted-foreground uppercase">
                      {t('billing.monthly', 'Monthly')}
                    </Text>
                  </View>
                  <Text className="text-2xl font-roobert-semibold text-foreground mb-1">
                    {formatCredits(monthlyCredits)}
                  </Text>
                  {monthlyRefreshTime && (
                    <Text className="text-xs font-roobert-medium text-orange-500">
                      {monthlyRefreshTime}
                    </Text>
                  )}
                </View>
              )}

              {/* Extra Credits */}
              <View className="bg-card border border-border rounded-[18px] p-5">
                <View className="flex-row items-center gap-2 mb-3">
                  <View className="w-8 h-8 rounded-full bg-blue-500/10 items-center justify-center">
                    <Icon as={Infinity} size={16} className="text-blue-500" strokeWidth={2} />
                  </View>
                  <Text className="text-xs font-roobert-medium text-muted-foreground uppercase">
                    {t('billing.extra', 'Extra')}
                  </Text>
                </View>
                <Text className="text-2xl font-roobert-semibold text-foreground mb-1">
                  {formatCredits(extraCredits)}
                </Text>
                <Text className="text-xs font-roobert-medium text-muted-foreground">
                  {t('billing.nonExpiring', 'Non-expiring')}
                </Text>
              </View>
            </View>
          </AnimatedView>

          {/* Subscription Info */}
          {subscription && (
            <AnimatedView
              entering={FadeIn.duration(400).delay(400)}
              className="px-6 mb-6"
            >
              <View className="bg-card border border-border rounded-[18px] p-6">
                <Text className="text-lg font-roobert-semibold text-foreground mb-4">
                  {t('billing.subscription', 'Subscription')}
                </Text>

                {/* Current Plan */}
                <View className="flex-row items-center justify-between mb-4">
                  <Text className="text-sm text-muted-foreground">
                    {t('billing.currentPlan', 'Current Plan')}
                  </Text>
                  <PricingTierBadge
                    planName={accountState?.subscription?.tier_display_name || accountState?.subscription?.tier_key || 'Basic'}
                    size="lg"
                  />
                </View>

                {/* Next Billing */}
                {nextBillingDate && (
                  <View className="flex-row items-center justify-between mb-4">
                    <View className="flex-row items-center gap-2">
                      <Icon as={Calendar} size={16} className="text-muted-foreground" strokeWidth={2} />
                      <Text className="text-sm text-muted-foreground">
                        {t('billing.nextBilling', 'Next Billing')}
                      </Text>
                    </View>
                    <Text className="text-sm font-roobert-medium text-foreground">
                      {nextBillingDate}
                    </Text>
                  </View>
                )}

                {/* Annual Commitment */}
                {hasCommitment && commitmentEndDate && (
                  <View className="flex-row items-center justify-between mb-4">
                    <View className="flex-row items-center gap-2">
                      <Icon as={CreditCard} size={16} className="text-muted-foreground" strokeWidth={2} />
                      <Text className="text-sm text-muted-foreground">
                        {t('billing.annualCommitment', 'Annual Commitment')}
                      </Text>
                    </View>
                    <Text className="text-sm font-roobert-medium text-foreground">
                      {t('billing.activeUntil', { defaultValue: 'Active until {date}', date: commitmentEndDate })}
                    </Text>
                  </View>
                )}


                {/* Cancelled Status */}
                {subscription.is_cancelled && subscription.cancellation_effective_date && (
                  <View className="bg-destructive/10 border border-destructive/20 rounded-xl p-4">
                    <View className="flex-row items-start gap-2">
                      <Icon as={AlertCircle} size={16} className="text-destructive" strokeWidth={2} />
                      <View className="flex-1">
                        <Text className="text-sm font-roobert-semibold text-destructive mb-1">
                          {t('billing.subscriptionCancelled', 'Subscription Cancelled')}
                        </Text>
                        <Text className="text-xs text-destructive/80">
                          {t('billing.subscriptionCancelledOn', {
                            defaultValue: 'Your subscription will be cancelled on {date}',
                            date: new Date(subscription.cancellation_effective_date).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            }),
                          })}
                        </Text>
                      </View>
                    </View>
                  </View>
                )}
              </View>
            </AnimatedView>
          )}

          {/* Action Buttons */}
          <AnimatedView
            entering={FadeIn.duration(400).delay(500)}
            className="px-6 mb-6"
          >
            <View className="gap-3">
              {/* Change Plan Button */}
              {onChangePlan && (
                <AnimatedPressable
                  onPress={handleChangePlan}
                  onPressIn={() => {
                    changePlanButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    changePlanButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={changePlanButtonStyle}
                  className="w-full h-12 bg-foreground rounded-2xl items-center justify-center flex-row gap-2"
                >
                  <Text className="text-sm font-roobert-semibold text-background">
                    {t('billing.changePlan', 'Change Plan')}
                  </Text>
                  <Icon as={ArrowRight} size={18} className="text-background" strokeWidth={2} />
                </AnimatedPressable>
              )}

              {/* Get Additional Credits */}
              {accountState?.subscription?.can_purchase_credits && (
                <AnimatedPressable
                  onPress={async () => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    // Use RevenueCat paywall for credit purchases
                    if (useNativePaywall) {
                      log.log('📱 Using RevenueCat paywall for additional credits');
                      await presentUpgradePaywall();
                    } else {
                      log.warn('⚠️ RevenueCat not available, cannot purchase credits');
                    }
                  }}
                  onPressIn={() => {
                    creditsButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    creditsButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={creditsButtonStyle}
                  className="w-full h-12 bg-primary rounded-2xl items-center justify-center flex-row gap-2"
                >
                  <Icon as={ShoppingCart} size={18} className="text-primary-foreground" strokeWidth={2} />
                  <Text className="text-sm font-roobert-semibold text-primary-foreground">
                    {t('billing.getAdditionalCredits', 'Get Additional Credits')}
                  </Text>
                </AnimatedPressable>
              )}

              {/* RevenueCat Customer Info Portal */}
              {useRevenueCat && (
                <AnimatedPressable
                  onPress={handleCustomerInfo}
                  onPressIn={() => {
                    customerInfoButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    customerInfoButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={customerInfoButtonStyle}
                  className="w-full h-12 bg-card border border-border rounded-2xl items-center justify-center flex-row gap-2"
                >
                  <Icon as={Settings} size={18} className="text-foreground" strokeWidth={2} />
                  <Text className="text-sm font-roobert-semibold text-foreground">
                    {t('billing.customerInfo', 'Customer Info')}
                  </Text>
                </AnimatedPressable>
              )}

            </View>
          </AnimatedView>

          {/* Credits Explained Link */}
          <AnimatedView
            entering={FadeIn.duration(400).delay(600)}
            className="px-6"
          >
            <AnimatedPressable
              onPress={handleCreditsExplained}
              onPressIn={() => {
                creditsLinkScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
              }}
              onPressOut={() => {
                creditsLinkScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
              style={creditsLinkStyle}
              className="flex-row items-center justify-center gap-2 py-2"
            >
              <Icon as={Lightbulb} size={14} className="text-muted-foreground" strokeWidth={2} />
              <Text className="text-xs font-roobert text-muted-foreground">
                {t('billing.creditsExplained', 'Credits explained')}
              </Text>
            </AnimatedPressable>
          </AnimatedView>
        </ScrollView>
      </View>
    </View>
  );
}
