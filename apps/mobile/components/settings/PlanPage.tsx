/**
 * Plan Page Component
 *
 * Selection-based pricing page with purchase button
 * Uses RevenueCat for native checkout on iOS/Android
 *
 * Features rich information density with credits, features, and savings
 */

import React, { useState, useMemo, useEffect } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Platform, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, AlertCircle, Check } from 'lucide-react-native';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import {
  PRICING_TIERS,
  type BillingPeriod,
  type PricingTier,
  useRevenueCatPricing,
  useSubscription,
  useSubscriptionCommitment,
  useScheduledChanges,
  useAccountState,
  billingKeys,
} from '@/lib/billing';
import { startUnifiedPlanCheckout } from '@/lib/billing/unified-checkout';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { purchasePackage, type SyncResponse } from '@/lib/billing/revenuecat';
import { invalidateAccountState } from '@/lib/billing/hooks';
import { useAuthContext, useLanguage } from '@/contexts';
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
import * as WebBrowser from 'expo-web-browser';
import type { PurchasesPackage } from 'react-native-purchases';

const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

// Parse credits from feature string (e.g., "CREDITS_BONUS:2000:4000")
function parseCreditsFromFeatures(
  features: string[]
): { base: number; bonus: number; total: number } | null {
  const creditsFeature = features.find((f) => f.startsWith('CREDITS_BONUS:'));
  if (!creditsFeature) return null;

  const parts = creditsFeature.split(':');
  const base = parseInt(parts[1]) || 0;
  const total = parseInt(parts[2]) || 0;
  const bonus = total - base;

  return { base, bonus, total };
}

// Get key features for display (excluding credits line)
function getKeyFeatures(
  features: string[],
  maxFeatures: number = 4,
  isFree: boolean = false
): { icon: typeof Check; text: string; description?: string }[] {
  return features
    .filter((f) => !f.startsWith('CREDITS_BONUS:'))
    .filter((f) => !isFree || !f.toLowerCase().includes('daily credits'))
    .slice(0, maxFeatures)
    .map((f) => {
      const parts = f.split(' - ');
      return {
        icon: Check,
        text: parts[0],
        description: parts[1],
      };
    });
}

interface PlanOption {
  tier: PricingTier;
  package: PurchasesPackage | null;
  commitmentType: 'monthly' | 'yearly_commitment';
  price: string;
  priceNumber: number;
  isAvailable: boolean;
}

interface PlanPageProps {
  visible?: boolean;
  onClose?: () => void;
  onPurchaseComplete?: () => void;
  customTitle?: string;
}

export function PlanPage({
  visible = true,
  onClose,
  onPurchaseComplete,
  customTitle,
}: PlanPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const { data: subscriptionData, refetch: refetchSubscription } = useSubscription({
    enabled: isUserAuthenticated,
  });
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription?.id, {
    enabled: isUserAuthenticated,
  });
  const { data: accountState } = useAccountState({ enabled: isUserAuthenticated });
  const { data: scheduledChangesData } = useScheduledChanges({
    enabled: isUserAuthenticated,
  });

  const isAuthenticated = isUserAuthenticated && !!subscriptionData;
  const useRevenueCat = shouldUseRevenueCat() && isRevenueCatConfigured();
  const { data: revenueCatPricing, isLoading: isLoadingPricing } = useRevenueCatPricing();

  // Determine current billing period
  const getCurrentBillingPeriod = (): BillingPeriod | null => {
    if (!isAuthenticated || !subscriptionData) return null;
    if (subscriptionData.billing_period) {
      const period = subscriptionData.billing_period;
      return period === 'yearly' ? 'yearly_commitment' : (period as BillingPeriod);
    }
    if (
      subCommitmentQuery.data?.has_commitment &&
      subCommitmentQuery.data?.commitment_type === 'yearly_commitment'
    ) {
      return 'yearly_commitment';
    }
    return 'monthly';
  };

  const currentBillingPeriod = getCurrentBillingPeriod();
  const [selectedPlanOption, setSelectedPlanOption] = useState<PlanOption | null>(null);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tierBillingPeriod, setTierBillingPeriod] = useState<Record<string, 'monthly' | 'yearly'>>(
    {}
  );
  const [hasAutoSelected, setHasAutoSelected] = useState(false);

  const purchaseButtonScale = useSharedValue(1);

  const purchaseButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: purchaseButtonScale.value }],
  }));

  // Build list of all plan options (monthly + yearly for each tier)
  const planOptions: PlanOption[] = [];

  PRICING_TIERS.filter((tier) => tier.hidden !== true).forEach((tier) => {
    const pricingData = revenueCatPricing?.get(tier.id);

    // Monthly option
    if (pricingData?.monthlyPackage || tier.priceMonthly >= 0) {
      planOptions.push({
        tier,
        package: pricingData?.monthlyPackage || null,
        commitmentType: 'monthly',
        price: pricingData && useRevenueCat ? pricingData.monthlyPriceString : tier.price,
        priceNumber: pricingData && useRevenueCat ? pricingData.monthlyPrice : tier.priceMonthly,
        isAvailable: pricingData?.isAvailable ?? true,
      });
    }

    // Yearly option - exclude Ultra (tier_25_200) as yearly is not available
    if (tier.id !== 'tier_25_200' && (pricingData?.yearlyPackage || tier.priceYearly)) {
      let yearlyPriceDisplay: string;
      if (pricingData && useRevenueCat && pricingData.yearlyPackage) {
        yearlyPriceDisplay = pricingData.yearlyPackage.product.priceString;
      } else {
        const yearlyTotal = tier.priceYearly ? tier.priceYearly * 12 : tier.priceMonthly * 12;
        yearlyPriceDisplay = `$${yearlyTotal}`;
      }

      planOptions.push({
        tier,
        package: pricingData?.yearlyPackage || null,
        commitmentType: 'yearly_commitment',
        price: yearlyPriceDisplay,
        priceNumber:
          pricingData && useRevenueCat && pricingData.yearlyPackage
            ? pricingData.yearlyPackage.product.price
            : tier.priceYearly
              ? tier.priceYearly * 12
              : tier.priceMonthly * 12,
        isAvailable: pricingData?.isAvailable ?? true,
      });
    }
  });

  // Sort by price (monthly)
  planOptions.sort((a, b) => a.priceNumber - b.priceNumber);

  // Group plan options by tier
  const tierGroups = useMemo(() => {
    const groups: Record<
      string,
      { monthly: PlanOption | null; yearly: PlanOption | null; tier: PricingTier }
    > = {};

    planOptions.forEach((opt) => {
      if (!groups[opt.tier.id]) {
        groups[opt.tier.id] = { monthly: null, yearly: null, tier: opt.tier };
      }
      if (opt.commitmentType === 'monthly') {
        groups[opt.tier.id].monthly = opt;
      } else {
        groups[opt.tier.id].yearly = opt;
      }
    });

    return Object.values(groups).sort((a, b) => {
      const priceA = a.monthly?.priceNumber ?? 0;
      const priceB = b.monthly?.priceNumber ?? 0;
      return priceA - priceB;
    });
  }, [planOptions]);

  const getTierBilling = (tierId: string): 'monthly' | 'yearly' => {
    return tierBillingPeriod[tierId] || 'monthly';
  };

  const hasYearlyOption = (tierId: string): boolean => {
    return tierId !== 'free' && tierId !== 'tier_25_200';
  };

  // Auto-select the first paid tier when page loads
  useEffect(() => {
    if (!hasAutoSelected && tierGroups.length > 0 && !selectedPlanOption && !isLoadingPricing) {
      const firstPaidGroup = tierGroups.find((g) => g.tier.id !== 'free');
      if (firstPaidGroup?.monthly) {
        console.log('📋 Auto-selecting recommended plan:', firstPaidGroup.tier.name);
        setSelectedPlanOption(firstPaidGroup.monthly);
        setHasAutoSelected(true);
      }
    }
  }, [tierGroups, selectedPlanOption, hasAutoSelected, isLoadingPricing]);

  const handleSubscriptionUpdate = () => {
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    refetchSubscription();
    subCommitmentQuery.refetch();
  };

  const handlePlanSelect = (option: PlanOption) => {
    setSelectedPlanOption(option);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handlePurchase = async () => {
    if (!selectedPlanOption || isPurchasing || !isAuthenticated) return;

    const currentProvider = subscriptionData?.provider as 'stripe' | 'revenuecat' | null;
    const currentTierKey = subscriptionData?.tier_key;
    const isStripeSubscriber =
      currentProvider === 'stripe' && currentTierKey && currentTierKey !== 'free';

    if (isStripeSubscriber) {
      console.warn('⚠️ Cannot subscribe - user has web subscription.');
      return;
    }

    try {
      setIsPurchasing(true);
      setError(null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (useRevenueCat && selectedPlanOption.package) {
        const syncResponseRef = { value: null as SyncResponse | null };

        await purchasePackage(
          selectedPlanOption.package,
          user?.email,
          user?.id,
          async (response) => {
            syncResponseRef.value = response;
            invalidateAccountState(queryClient);
            await refetchSubscription();
          }
        );

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        const syncResponse: SyncResponse | null = syncResponseRef.value;
        if (syncResponse?.status === 'pending_webhook') {
          console.log('⏳ Webhook processing - will refetch in 15 seconds');
          setTimeout(async () => {
            invalidateAccountState(queryClient);
            await refetchSubscription();
          }, 15000);
        }

        onPurchaseComplete?.();
        return;
      }

      // Fallback to unified checkout
      await startUnifiedPlanCheckout(
        selectedPlanOption.tier.id,
        selectedPlanOption.commitmentType,
        () => {
          handleSubscriptionUpdate();
          onPurchaseComplete?.();
        },
        () => {},
        async (response) => {
          invalidateAccountState(queryClient);
          await refetchSubscription();

          if (response.status === 'pending_webhook') {
            setTimeout(async () => {
              invalidateAccountState(queryClient);
              await refetchSubscription();
            }, 15000);
          }
        }
      );
    } catch (err: any) {
      const isAlreadySubscribedDifferentAccount =
        err.code === 'ALREADY_SUBSCRIBED_DIFFERENT_ACCOUNT' ||
        err.code === 'PRODUCT_ALREADY_PURCHASED' ||
        err.code === 'ALREADY_PURCHASED' ||
        (err.message?.toLowerCase().includes('already') &&
          err.message?.toLowerCase().includes('subscribed'));

      const isSessionError =
        err.code === 'SESSION_FIX_FAILED' ||
        err.code === 'ANONYMOUS_USER' ||
        err.code === 'USER_MISMATCH';

      if (isAlreadySubscribedDifferentAccount) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        const platform = Platform.OS === 'ios' ? 'Apple ID' : 'Google Play ID';
        Alert.alert(
          t('billing.subscriptionExists', 'Already Subscribed'),
          `You are already subscribed with a different account on this ${platform}. Please log into your original account to access your subscription.`,
          [{ text: t('billing.gotIt', 'Got it') }]
        );
      } else if (isSessionError) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(
          'Unable to connect to the store. Please close and reopen the app, then try again.'
        );
      } else if (!err.userCancelled) {
        console.error('Purchase error:', err);
        setError(err.message || 'Purchase failed');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setIsPurchasing(false);
    }
  };

  const isCurrentPlan = (option: PlanOption): boolean => {
    if (!isAuthenticated || !subscriptionData) return false;
    return (
      subscriptionData.tier_key === option.tier.id &&
      (option.commitmentType === 'monthly'
        ? currentBillingPeriod === 'monthly'
        : currentBillingPeriod === 'yearly_commitment' || currentBillingPeriod === 'yearly')
    );
  };

  const scheduledChange =
    scheduledChangesData?.scheduled_change || accountState?.subscription?.scheduled_change;
  const hasScheduledChange =
    scheduledChangesData?.has_scheduled_change ??
    accountState?.subscription?.has_scheduled_change ??
    false;

  useEffect(() => {
    if (hasScheduledChange) {
      console.log('📅 Scheduled change detected:', {
        scheduledChange,
        targetTierName: scheduledChange?.target_tier?.name,
      });
    }
  }, [hasScheduledChange, scheduledChange]);

  const isScheduledTargetPlan = (option: PlanOption): boolean => {
    if (!hasScheduledChange || !scheduledChange) return false;
    return scheduledChange.target_tier.name === option.tier.id;
  };

  const getCurrentProvider = (): 'stripe' | 'revenuecat' | null => {
    if (!isAuthenticated || !subscriptionData) return null;
    return subscriptionData.provider as 'stripe' | 'revenuecat' | null;
  };

  const currentProvider = getCurrentProvider();
  const currentTierKey = subscriptionData?.tier_key;
  const isStripeSubscriber =
    currentProvider === 'stripe' && currentTierKey && currentTierKey !== 'free';

  if (!visible) return null;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <AnimatedView
        entering={FadeIn.duration(400)}
        className="border-b border-border/30 bg-background px-6"
        style={{ paddingTop: insets.top + 12, paddingBottom: 16 }}>
        <View className="flex-row items-center justify-between">
          <Text className="font-roobert-semibold text-xl text-foreground">
            {customTitle || t('billing.pickPlan', 'Pick the plan that works for you')}
          </Text>
          {onClose && (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onClose();
              }}
              className="-mr-2 h-10 w-10 items-center justify-center">
              <Icon as={X} size={20} className="text-muted-foreground" strokeWidth={2} />
            </Pressable>
          )}
        </View>
      </AnimatedView>

      <AnimatedScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: 16 }}>
        {/* Scheduled Change Alert */}
        {hasScheduledChange && scheduledChange && (
          <AnimatedView entering={FadeIn.duration(400).delay(150)} className="mb-4 px-6">
            <ScheduledDowngradeCard
              scheduledChange={scheduledChange}
              variant="compact"
              onCancel={handleSubscriptionUpdate}
            />
          </AnimatedView>
        )}

        {/* Plan Cards */}
        {!isStripeSubscriber && (
          <AnimatedView entering={FadeIn.duration(600).delay(200)} className="mb-6 px-4">
            {isLoadingPricing && useRevenueCat ? (
              <View className="items-center py-12">
                <ActivityIndicator size="large" />
                <Text className="mt-4 text-muted-foreground">Loading plans...</Text>
              </View>
            ) : (
              tierGroups.map((group) => {
                const { tier, monthly, yearly } = group;
                const tierId = tier.id;
                const isFree = tierId === 'free';
                const hasYearly = hasYearlyOption(tierId) && yearly;
                const selectedBilling = getTierBilling(tierId);

                const option = selectedBilling === 'yearly' && hasYearly ? yearly : monthly;
                if (!option) return null;

                const isSelected =
                  selectedPlanOption?.tier.id === option.tier.id &&
                  selectedPlanOption?.commitmentType === option.commitmentType;
                const isCurrent = isCurrentPlan(option);
                const isScheduledTarget = isScheduledTargetPlan(option);
                const credits = parseCreditsFromFeatures(option.tier.features);
                const keyFeatures = getKeyFeatures(option.tier.features, 4, isFree);
                const dailyCredits = isFree ? 100 : null;

                return (
                  <Pressable
                    key={tierId}
                    onPress={() => {
                      if (!isCurrent && !isScheduledTarget) {
                        handlePlanSelect(option);
                      }
                    }}
                    className={`mb-4 overflow-hidden rounded-[18px] border-2 ${
                      isSelected
                        ? 'border-primary bg-primary/10'
                        : isScheduledTarget
                          ? 'border-yellow-500/30 bg-yellow-500/5'
                          : isFree
                            ? 'border-border/30 bg-muted/30'
                            : 'border-border/30 bg-card'
                    } ${!option.isAvailable ? 'opacity-60' : ''}`}>
                    {/* Header Section */}
                    <View className="p-4 pb-3">
                      <View className="flex-row items-start justify-between">
                        <View className="flex-1">
                          <View className="mb-1 flex-row flex-wrap items-center gap-2">
                            <Text className="font-roobert-semibold text-lg text-foreground">
                              {tier.name}
                            </Text>
                            {isCurrent && (
                              <View className="rounded-full bg-primary/10 px-2 py-0.5">
                                <Text className="font-roobert-medium text-[10px] text-primary">
                                  {t('billing.current', 'Current')}
                                </Text>
                              </View>
                            )}
                            {isScheduledTarget && (
                              <View className="rounded-full bg-yellow-500/10 px-2 py-0.5">
                                <Text
                                  className="font-roobert-medium text-[10px]"
                                  style={{ color: isDark ? '#fbbf24' : '#d97706' }}>
                                  {t('billing.scheduledBadge', 'Scheduled')}
                                </Text>
                              </View>
                            )}
                          </View>

                          {/* Billing Toggle */}
                          {hasYearly && (
                            <Pressable
                              onPress={(e) => {
                                e.stopPropagation();
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                const newBilling =
                                  selectedBilling === 'monthly' ? 'yearly' : 'monthly';
                                setTierBillingPeriod((prev) => ({ ...prev, [tierId]: newBilling }));
                                const newOption = newBilling === 'yearly' ? yearly : monthly;
                                if (newOption) {
                                  handlePlanSelect(newOption);
                                }
                              }}
                              className="mt-2 flex-row items-center gap-2">
                              <Text
                                className={`font-roobert-medium text-xs ${
                                  selectedBilling === 'monthly'
                                    ? 'text-foreground'
                                    : 'text-muted-foreground'
                                }`}>
                                Monthly
                              </Text>
                              <View
                                className={`h-6 w-11 rounded-full p-0.5 ${
                                  selectedBilling === 'yearly' ? 'bg-primary' : 'bg-muted'
                                }`}>
                                <View
                                  className={`h-5 w-5 rounded-full bg-white shadow-sm ${
                                    selectedBilling === 'yearly' ? 'ml-auto' : ''
                                  }`}
                                />
                              </View>
                              <Text
                                className={`font-roobert-medium text-xs ${
                                  selectedBilling === 'yearly'
                                    ? 'text-foreground'
                                    : 'text-muted-foreground'
                                }`}>
                                Annual
                              </Text>
                            </Pressable>
                          )}
                        </View>

                        {/* Price */}
                        <View className="items-end">
                          <Text className="font-roobert-semibold text-2xl text-foreground">
                            {option.price}
                          </Text>
                          {option.commitmentType === 'yearly_commitment' &&
                            option.price !== '$0' && (
                              <Text className="mt-0.5 text-xs text-muted-foreground">/year</Text>
                            )}
                          {option.commitmentType === 'monthly' && option.price !== '$0' && (
                            <Text className="mt-0.5 text-xs text-muted-foreground">/month</Text>
                          )}
                        </View>
                      </View>
                    </View>

                    {/* Credits Section */}
                    <View className="px-4 pb-3">
                      {isFree ? (
                        <View className="flex-row items-start gap-3">
                          <View className="mt-0.5 h-5 w-5 items-center justify-center">
                            <Icon as={Check} size={16} className="text-primary" strokeWidth={2.5} />
                          </View>
                          <View className="flex-1">
                            <Text className="font-roobert-medium text-sm text-foreground">
                              {dailyCredits} Daily Credits
                            </Text>
                            <Text className="mt-0.5 text-xs text-muted-foreground">
                              Refreshes every 24 hours (applies to all tiers)
                            </Text>
                          </View>
                        </View>
                      ) : credits ? (
                        <View className="flex-row items-start gap-3">
                          <View className="mt-0.5 h-5 w-5 items-center justify-center">
                            <Icon as={Check} size={16} className="text-primary" strokeWidth={2.5} />
                          </View>
                          <View className="flex-1">
                            <View className="flex-row flex-wrap items-center gap-2">
                              <Text className="text-sm text-muted-foreground line-through">
                                {credits.base.toLocaleString()}
                              </Text>
                              <Text className="font-roobert-bold text-sm text-primary">
                                {credits.total.toLocaleString()}
                              </Text>
                              <Text className="font-roobert-medium text-sm text-foreground">
                                Monthly Credits
                              </Text>
                              <View
                                className="rounded-md bg-gradient-to-r px-2 py-0.5"
                                style={{
                                  backgroundColor: isDark
                                    ? 'rgba(251, 191, 36, 0.15)'
                                    : 'rgba(251, 191, 36, 0.1)',
                                }}>
                                <Text
                                  className="font-roobert-bold text-[10px]"
                                  style={{ color: isDark ? '#fbbf24' : '#d97706' }}>
                                  2x BONUS
                                </Text>
                              </View>
                            </View>
                            <Text className="mt-0.5 text-xs text-muted-foreground">
                              Refreshes each billing cycle
                            </Text>
                          </View>
                        </View>
                      ) : null}
                    </View>

                    {/* Features List */}
                    {keyFeatures.length > 0 && (
                      <View className="px-4 pb-4">
                        <View className="space-y-2.5">
                          {keyFeatures.map((feature, idx) => (
                            <View key={idx} className="flex-row items-start gap-3">
                              <View className="mt-0.5 h-5 w-5 items-center justify-center">
                                <Icon
                                  as={Check}
                                  size={16}
                                  className="text-primary"
                                  strokeWidth={2.5}
                                />
                              </View>
                              <View className="flex-1">
                                <Text className="font-roobert-medium text-sm text-foreground">
                                  {feature.text}
                                </Text>
                                {feature.description && (
                                  <Text className="mt-0.5 text-xs text-muted-foreground">
                                    {feature.description}
                                  </Text>
                                )}
                              </View>
                            </View>
                          ))}
                        </View>

                        {/* Disabled features for free tier */}
                        {isFree && tier.disabledFeatures && tier.disabledFeatures.length > 0 && (
                          <View className="mt-3 space-y-2 border-t border-border/50 pt-3">
                            {tier.disabledFeatures.map((feature, idx) => (
                              <View key={idx} className="flex-row items-center gap-3 opacity-50">
                                <Icon
                                  as={X}
                                  size={16}
                                  className="text-muted-foreground"
                                  strokeWidth={2}
                                />
                                <Text className="text-sm text-muted-foreground line-through">
                                  {feature}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    )}

                    {/* Intro Price Badge */}
                    {option.package?.product.introPrice && (
                      <View className="px-4 pb-4">
                        <View className="rounded-lg bg-primary/10 px-3 py-2">
                          <Text className="text-center font-roobert-medium text-xs text-primary">
                            🎉 {option.package.product.introPrice.priceString} for first{' '}
                            {option.package.product.introPrice.period}
                          </Text>
                        </View>
                      </View>
                    )}
                  </Pressable>
                );
              })
            )}
          </AnimatedView>
        )}

        {/* Stripe Subscriber Message */}
        {isStripeSubscriber && (
          <AnimatedView entering={FadeIn.duration(600).delay(200)} className="mb-6 px-6">
            <View className="rounded-[18px] border border-border bg-card p-5">
              <View className="flex-row items-start gap-4">
                <View className="rounded-full bg-primary/10 p-2.5">
                  <Icon as={AlertCircle} size={20} className="text-primary" strokeWidth={2} />
                </View>
                <View className="flex-1">
                  <Text className="mb-1 font-roobert-semibold text-base text-foreground">
                    {t('billing.webSubscriptionActive', 'Web Subscription Active')}
                  </Text>
                  <Text className="text-sm leading-relaxed text-muted-foreground">
                    {t(
                      'billing.stripeSubscriberMessage',
                      'You have a web subscription. Please manage your plan on the web platform where you upgraded.'
                    )}
                  </Text>
                </View>
              </View>
            </View>
          </AnimatedView>
        )}
      </AnimatedScrollView>

      {/* Purchase Button & Footer */}
      {!isStripeSubscriber &&
        (() => {
          const selectedPlan = selectedPlanOption;
          const isCurrent = selectedPlan ? isCurrentPlan(selectedPlan) : false;
          const isScheduledTarget = selectedPlan ? isScheduledTargetPlan(selectedPlan) : false;
          const isDisabled = isPurchasing || isCurrent || isScheduledTarget;

          return (
            <AnimatedView
              entering={FadeIn.duration(600).delay(500)}
              className="border-t border-border/50 bg-background px-6 py-4"
              style={{ paddingBottom: insets.bottom + 8 }}>
              {selectedPlan ? (
                <AnimatedView style={[purchaseButtonStyle, { opacity: isDisabled ? 0.5 : 1 }]}>
                  <Pressable
                    onPress={handlePurchase}
                    disabled={isDisabled}
                    onPressIn={() => {
                      if (!isPurchasing && !isDisabled) {
                        purchaseButtonScale.value = withSpring(0.96, {
                          damping: 15,
                          stiffness: 400,
                        });
                      }
                    }}
                    onPressOut={() => {
                      purchaseButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                    }}
                    className={`h-12 w-full items-center justify-center rounded-xl ${
                      isDisabled ? 'bg-primary/5' : 'bg-primary'
                    }`}>
                    {isPurchasing ? (
                      <ActivityIndicator color={isDark ? '#fff' : '#000'} />
                    ) : (
                      <Text
                        className={`font-roobert-medium text-sm ${
                          isDisabled ? 'text-primary' : 'text-primary-foreground'
                        }`}>
                        {isCurrent
                          ? t('billing.currentPlan', 'Current Plan')
                          : isScheduledTarget
                            ? t('billing.scheduled', 'Scheduled')
                            : selectedPlan.tier.id === 'free'
                              ? t('billing.selectPlan', 'Select Plan')
                              : t('billing.upgrade', 'Upgrade')}
                      </Text>
                    )}
                  </Pressable>
                </AnimatedView>
              ) : (
                <View className="h-12 w-full items-center justify-center rounded-xl bg-muted">
                  <Text className="font-roobert-medium text-sm text-muted-foreground">
                    {t('billing.selectPlan', 'Select a plan')}
                  </Text>
                </View>
              )}

              {error && (
                <View className="mt-3 rounded-lg bg-destructive/10 px-4 py-2">
                  <Text className="text-center font-roobert-medium text-sm text-destructive">
                    {error}
                  </Text>
                </View>
              )}

              {/* Legal disclaimer */}
              <Text className="mt-3 px-4 text-center text-[10px] text-muted-foreground">
                {Platform.OS === 'ios'
                  ? t(
                      'billing.subscriptionDisclaimerIos',
                      'Payment will be charged to your Apple ID account at confirmation of purchase. Subscription automatically renews unless auto-renew is turned off at least 24-hours before the end of the current period. Your account will be charged for renewal within 24-hours prior to the end of the current period. You can manage and cancel your subscriptions by going to your account settings on the App Store after purchase.'
                    )
                  : t(
                      'billing.subscriptionDisclaimerAndroid',
                      'Payment will be charged to your Google account at confirmation of purchase. Subscription automatically renews unless auto-renew is turned off at least 24-hours before the end of the current period. You can manage and cancel your subscriptions by going to the Google Play Store.'
                    )}
              </Text>

              <View className="mt-4 flex-row justify-center gap-4">
                <Pressable
                  onPress={() =>
                    WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=privacy')
                  }>
                  <Text className="font-roobert-medium text-xs text-muted-foreground underline">
                    {t('billing.privacyPolicy', 'Privacy Policy')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=terms')
                  }>
                  <Text className="font-roobert-medium text-xs text-muted-foreground underline">
                    {t('billing.termsOfService', 'Terms of Service')}
                  </Text>
                </Pressable>
              </View>
            </AnimatedView>
          );
        })()}
    </View>
  );
}
