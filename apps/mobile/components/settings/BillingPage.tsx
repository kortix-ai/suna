/**
 * Billing Page Component
 * 
 * Matches web's "Billing Status – Manage your credits and subscription" design
 */

import React, { useState, useCallback } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SettingsHeader } from './SettingsHeader';
import { CreditPurchaseModal } from '@/components/billing/CreditPurchaseModal';
import { PricingTierBadge } from '@/components/billing/PricingTierBadge';
import {
  useAccountState,
  accountStateSelectors,
  useSubscriptionCommitment,
  useScheduledChanges,
  billingKeys,
} from '@/lib/billing';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
} from 'lucide-react-native';
import { formatCredits } from '@/lib/utils/credit-formatter';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';

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

  const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);

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
        : 'https://kortix.com';
      await WebBrowser.openBrowserAsync(`${baseUrl}/credits-explained`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      console.error('Error opening credits explained page:', error);
    }
  }, []);

  const creditsButtonScale = useSharedValue(1);
  const creditsLinkScale = useSharedValue(1);
  const changePlanButtonScale = useSharedValue(1);

  const creditsButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsButtonScale.value }],
  }));

  const creditsLinkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsLinkScale.value }],
  }));

  const changePlanButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: changePlanButtonScale.value }],
  }));

  const handleChangePlan = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onChangePlan?.();
  }, [onChangePlan]);

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
    
    if (dailyRefreshInfo.seconds_until_refresh) {
      const hours = Math.ceil(dailyRefreshInfo.seconds_until_refresh / 3600);
      if (hours === 1) {
        return t('billing.refreshIn1Hour', 'Refresh in 1 hour');
      }
      return t('billing.refreshInHours', { defaultValue: 'Refresh in {hours}h', hours });
    }
    
    if (dailyRefreshInfo.next_refresh_at) {
      const nextRefresh = new Date(dailyRefreshInfo.next_refresh_at);
      const now = new Date();
      const diffHours = Math.ceil((nextRefresh.getTime() - now.getTime()) / (1000 * 60 * 60));
      if (diffHours <= 24) {
        if (diffHours === 1) {
          return t('billing.refreshIn1Hour', 'Refresh in 1 hour');
        }
        return t('billing.refreshInHours', { defaultValue: 'Refresh in {hours}h', hours: diffHours });
      }
      return t('billing.refreshIn24Hours', 'Refresh in 24 hours');
    }
    
    return t('billing.refreshIn24Hours', 'Refresh in 24 hours');
  };

  // Calculate refresh time for monthly credits (same as daily if daily refresh enabled)
  const getMonthlyRefreshTime = (): string | null => {
    if (dailyRefreshInfo?.enabled) {
      // If daily refresh is enabled, monthly also refreshes with daily
      return getDailyRefreshTime();
    }
    // Otherwise show next billing date
    return nextBillingDate ? t('billing.renews', { defaultValue: 'Renews {date}', date: nextBillingDate }) : null;
  };

  // Calculate next billing date
  const getNextBillingDate = (): string | null => {
    if (!accountState?.subscription?.current_period_end) return null;
    const periodEnd = typeof accountState.subscription.current_period_end === 'number'
      ? accountState.subscription.current_period_end * 1000
      : new Date(accountState.subscription.current_period_end).getTime();
    return new Date(periodEnd).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
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
                  {monthlyRefreshTime ? (
                    <Text className="text-xs font-roobert-medium text-orange-500">
                      {monthlyRefreshTime}
                    </Text>
                  ) : (
                    <Text className="text-xs font-roobert-medium text-muted-foreground">
                      {t('billing.noRenewal', 'No renewal')}
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
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setShowCreditPurchaseModal(true);
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

      {/* Credit Purchase Modal */}
      <CreditPurchaseModal
        open={showCreditPurchaseModal}
        onOpenChange={setShowCreditPurchaseModal}
        currentBalance={totalCredits}
        canPurchase={accountState?.subscription?.can_purchase_credits || false}
        onPurchaseComplete={handleSubscriptionUpdate}
      />
    </View>
  );
}
