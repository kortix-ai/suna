/**
 * Plan Page Component
 * 
 * Selection-based pricing page with purchase button
 * Uses RevenueCat for native checkout on iOS/Android
 * 
 * Features rich information density with credits, features, and savings
 */

import React, { useState, useMemo, useEffect } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, AlertCircle, Check } from 'lucide-react-native';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import { PRICING_TIERS, type BillingPeriod, type PricingTier } from '@/lib/billing';
import { useRevenueCatPricing } from '@/lib/billing';
import { startUnifiedPlanCheckout } from '@/lib/billing/unified-checkout';
import { useSubscription, useSubscriptionCommitment, useScheduledChanges, useAccountState, billingKeys, invalidateCreditsAfterPurchase } from '@/lib/billing';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { purchasePackage, type SyncResponse } from '@/lib/billing/revenuecat';
import { invalidateAccountState, accountStateKeys } from '@/lib/billing/hooks';
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
import { Alert } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { PurchasesPackage } from 'react-native-purchases';

const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

// Parse credits from feature string (e.g., "CREDITS_BONUS:2000:4000")
function parseCreditsFromFeatures(features: string[]): { base: number; bonus: number; total: number } | null {
  const creditsFeature = features.find(f => f.startsWith('CREDITS_BONUS:'));
  if (!creditsFeature) return null;
  
  const parts = creditsFeature.split(':');
  const base = parseInt(parts[1]) || 0;
  const total = parseInt(parts[2]) || 0;
  const bonus = total - base;
  
  return { base, bonus, total };
}

// Get key features for display (excluding credits line)
function getKeyFeatures(features: string[], maxFeatures: number = 4, isFree: boolean = false): { icon: typeof Check; text: string; description?: string }[] {
  return features
    .filter(f => !f.startsWith('CREDITS_BONUS:'))
    .filter(f => !isFree || !f.toLowerCase().includes('daily credits')) // Filter out daily credits for free tier (shown separately)
    .slice(0, maxFeatures)
    .map(f => {
      // Extract the main part and description
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


export function PlanPage({ visible = true, onClose, onPurchaseComplete, customTitle }: PlanPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const { data: subscriptionData, isLoading: isFetchingPlan, refetch: refetchSubscription } = useSubscription({ enabled: isUserAuthenticated });
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription?.id, {
    enabled: isUserAuthenticated
  });
  const { data: accountState } = useAccountState({ enabled: isUserAuthenticated });
  const { data: scheduledChangesData } = useScheduledChanges({
    enabled: isUserAuthenticated
  });

  const isAuthenticated = isUserAuthenticated && !!subscriptionData;
  const useRevenueCat = shouldUseRevenueCat() && isRevenueCatConfigured();
  const { data: revenueCatPricing, isLoading: isLoadingPricing } = useRevenueCatPricing();

  // Determine current billing period
  const getCurrentBillingPeriod = (): BillingPeriod | null => {
    if (!isAuthenticated || !subscriptionData) return null;
    if (subscriptionData.billing_period) {
      const period = subscriptionData.billing_period;
      return period === 'yearly' ? 'yearly_commitment' : period as BillingPeriod;
    }
    if (subCommitmentQuery.data?.has_commitment &&
      subCommitmentQuery.data?.commitment_type === 'yearly_commitment') {
      return 'yearly_commitment';
    }
    return 'monthly';
  };

  const currentBillingPeriod = getCurrentBillingPeriod();
  const [selectedPlanOption, setSelectedPlanOption] = useState<PlanOption | null>(null);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-tier billing period selection (tier_id -> 'monthly' | 'yearly')
  const [tierBillingPeriod, setTierBillingPeriod] = useState<Record<string, 'monthly' | 'yearly'>>({});

  const purchaseButtonScale = useSharedValue(1);

  const purchaseButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: purchaseButtonScale.value }],
  }));

  // Build list of all plan options (monthly + yearly for each tier)
  const planOptions: PlanOption[] = [];
  
  PRICING_TIERS.filter(tier => tier.hidden !== true).forEach(tier => {
    const pricingData = revenueCatPricing?.get(tier.id);
    
    // Monthly option
    if (pricingData?.monthlyPackage || tier.priceMonthly >= 0) {
      planOptions.push({
        tier,
        package: pricingData?.monthlyPackage || null,
        commitmentType: 'monthly',
        price: pricingData && useRevenueCat 
          ? pricingData.monthlyPriceString 
          : tier.price,
        priceNumber: pricingData && useRevenueCat
          ? pricingData.monthlyPrice
          : tier.priceMonthly,
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
        priceNumber: pricingData && useRevenueCat && pricingData.yearlyPackage
          ? pricingData.yearlyPackage.product.price
          : (tier.priceYearly ? tier.priceYearly * 12 : tier.priceMonthly * 12),
        isAvailable: pricingData?.isAvailable ?? true,
      });
    }
  });

  // Sort by price (monthly)
  planOptions.sort((a, b) => a.priceNumber - b.priceNumber);

  // Group plan options by tier
  const tierGroups = useMemo(() => {
    const groups: Record<string, { monthly: PlanOption | null; yearly: PlanOption | null; tier: PricingTier }> = {};
    
    planOptions.forEach(opt => {
      if (!groups[opt.tier.id]) {
        groups[opt.tier.id] = { monthly: null, yearly: null, tier: opt.tier };
      }
      if (opt.commitmentType === 'monthly') {
        groups[opt.tier.id].monthly = opt;
      } else {
        groups[opt.tier.id].yearly = opt;
      }
    });
    
    // Return as array sorted by monthly price
    return Object.values(groups).sort((a, b) => {
      const priceA = a.monthly?.priceNumber ?? 0;
      const priceB = b.monthly?.priceNumber ?? 0;
      return priceA - priceB;
    });
  }, [planOptions]);

  // Helper to get selected billing period for a tier
  const getTierBilling = (tierId: string): 'monthly' | 'yearly' => {
    return tierBillingPeriod[tierId] || 'monthly';
  };

  // Helper to check if tier has yearly option
  const hasYearlyOption = (tierId: string): boolean => {
    return tierId !== 'free' && tierId !== 'tier_25_200'; // Ultra doesn't have yearly
  };

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

    // Block subscription if user has Stripe subscription (web checkout disabled)
    const currentProvider = subscriptionData?.provider as 'stripe' | 'revenuecat' | null;
    const currentTierKey = subscriptionData?.tier_key;
    const isStripeSubscriber = currentProvider === 'stripe' && currentTierKey && currentTierKey !== 'free';
    
    if (isStripeSubscriber) {
      console.warn('⚠️ Cannot subscribe - user has web subscription. Please manage on web platform.');
      return;
    }

    try {
      setIsPurchasing(true);
      setError(null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

        // Use RevenueCat purchase if package available
      if (useRevenueCat && selectedPlanOption.package) {
        const syncResponseRef = { value: null as SyncResponse | null };
        
        await purchasePackage(
          selectedPlanOption.package, 
          user?.email, 
          user?.id,
          async (response) => {
            syncResponseRef.value = response;
            // Immediately invalidate cache to trigger refetch
            invalidateAccountState(queryClient);
            await refetchSubscription();
          }
        );
        
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        
        // If webhook is pending, schedule a single refetch after webhook processes
        // Backend invalidates cache when webhook processes, but we schedule a refetch
        // as a safety net since mobile doesn't get push notifications
        const syncResponse: SyncResponse | null = syncResponseRef.value;
        if (syncResponse?.status === 'pending_webhook') {
          console.log('⏳ Webhook processing - will refetch in 15 seconds');
          setTimeout(async () => {
            invalidateAccountState(queryClient);
          await refetchSubscription();
          }, 15000); // Webhook typically processes within 10-30 seconds
        }
        
        // Let onPurchaseComplete handle navigation - don't call onClose here
        // This prevents double navigation and auth issues
          onPurchaseComplete?.();
          return;
      }

      // Fallback to unified checkout
      await startUnifiedPlanCheckout(
        selectedPlanOption.tier.id,
        selectedPlanOption.commitmentType,
        () => {
          handleSubscriptionUpdate();
          // Let onPurchaseComplete handle navigation - don't call onClose here
          onPurchaseComplete?.();
        },
        () => {},
        async (response) => {
          // Handle sync response - invalidate cache immediately
          invalidateAccountState(queryClient);
          await refetchSubscription();
          
          // If pending webhook, schedule a single refetch after webhook processes
          if (response.status === 'pending_webhook') {
            console.log('⏳ Webhook processing - will refetch in 15 seconds');
            setTimeout(async () => {
              invalidateAccountState(queryClient);
              await refetchSubscription();
            }, 15000);
          }
        }
      );
    } catch (err: any) {
      // Check if this is an "already subscribed with different account" error
      const isAlreadySubscribedDifferentAccount = 
        err.code === 'ALREADY_SUBSCRIBED_DIFFERENT_ACCOUNT' ||
        err.code === 'PRODUCT_ALREADY_PURCHASED' ||
        err.code === 'ALREADY_PURCHASED' ||
        (err.message?.toLowerCase().includes('already') && err.message?.toLowerCase().includes('subscribed'));

      // Check if this is a session/linking error
      const isSessionError = 
        err.code === 'SESSION_FIX_FAILED' ||
        err.code === 'ANONYMOUS_USER' ||
        err.code === 'USER_MISMATCH';

      if (isAlreadySubscribedDifferentAccount) {
        // Apple ID already has a subscription on another account - show alert
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          t('billing.subscriptionExists', 'Already Subscribed'),
          Platform.OS === 'ios' 
            ? 'You are already subscribed with a different account on this Apple ID. Please log into your original account to access your subscription.'
            : 'You are already subscribed with a different account on this Google Play ID. Please log into your original account to access your subscription.',
          [{ text: t('billing.gotIt', 'Got it') }]
        );
      } else if (isSessionError) {
        // Session linking issue - show error message
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError('Unable to connect to the store. Please close and reopen the app, then try again.');
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
    return subscriptionData.tier_key === option.tier.id && 
           (option.commitmentType === 'monthly' 
             ? currentBillingPeriod === 'monthly'
             : (currentBillingPeriod === 'yearly_commitment' || currentBillingPeriod === 'yearly'));
  };

  // Get scheduled change info - check both scheduledChangesData and accountState (like BillingPage does)
  const scheduledChange = scheduledChangesData?.scheduled_change || accountState?.subscription?.scheduled_change;
  const hasScheduledChange = scheduledChangesData?.has_scheduled_change ?? accountState?.subscription?.has_scheduled_change ?? false;
  
  // Debug logging
  useEffect(() => {
    if (hasScheduledChange) {
      console.log('📅 Scheduled change detected:', {
        scheduledChange,
        targetTierName: scheduledChange?.target_tier?.name,
        targetTierDisplayName: scheduledChange?.target_tier?.display_name,
        hasScheduledChange,
        accountStateHasScheduled: accountState?.subscription?.has_scheduled_change,
        scheduledChangesDataHasScheduled: scheduledChangesData?.has_scheduled_change,
      });
    }
  }, [hasScheduledChange, scheduledChange, accountState, scheduledChangesData]);
  
  // Check if a plan option is the scheduled target plan
  const isScheduledTargetPlan = (option: PlanOption): boolean => {
    if (!hasScheduledChange || !scheduledChange) return false;
    const targetTierName = scheduledChange.target_tier.name;
    const optionTierId = option.tier.id;
    const matches = targetTierName === optionTierId;
    if (matches) {
      console.log('✅ Scheduled target plan match:', { targetTierName, optionTierId });
    }
    return matches;
  };
  

  const getCurrentProvider = (): 'stripe' | 'revenuecat' | null => {
    if (!isAuthenticated || !subscriptionData) return null;
    return subscriptionData.provider as 'stripe' | 'revenuecat' | null;
  };

  const currentProvider = getCurrentProvider();
  const currentTierKey = subscriptionData?.tier_key;
  const isStripeSubscriber = currentProvider === 'stripe' && currentTierKey && currentTierKey !== 'free';
  const isRevenueCatSubscriber = currentProvider === 'revenuecat';

  if (!visible) return null;

  return (
    <View className="flex-1 bg-background">
      {/* Header with Title and Toggle */}
        <AnimatedView 
          entering={FadeIn.duration(400)}
        className="px-6 bg-background border-b border-border/30"
        style={{ paddingTop: insets.top + 12, paddingBottom: 16 }}
        >
        {/* Title row with close button on right */}
        <View className="flex-row items-center justify-between">
          <Text className="text-xl font-roobert-semibold text-foreground">
            {customTitle || t('billing.pickPlan', 'Pick the plan that works for you')}
          </Text>
          {onClose && (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onClose();
              }}
              className="h-10 w-10 items-center justify-center -mr-2"
          >
              <Icon as={X} size={20} className="text-muted-foreground" strokeWidth={2} />
            </Pressable>
          )}
        </View>
        </AnimatedView>

      <AnimatedScrollView 
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ 
          paddingTop: 16,
          paddingBottom: 16
        }}
      >
        {/* Scheduled Change Alert - compact variant like frontend */}
        {hasScheduledChange && scheduledChange && (
        <AnimatedView 
            entering={FadeIn.duration(400).delay(150)}
          className="px-6 mb-4"
        >
            <ScheduledDowngradeCard
              scheduledChange={scheduledChange}
              variant="compact"
              onCancel={handleSubscriptionUpdate}
            />
        </AnimatedView>
        )}

        {/* Plan Cards - Each tier with its own billing toggle */}
        {/* Hide plans if user has Stripe subscription */}
        {!isStripeSubscriber && (
          <AnimatedView 
            entering={FadeIn.duration(600).delay(200)} 
            className="px-4 mb-6"
          >
            {isLoadingPricing && useRevenueCat ? (
              <View className="py-12 items-center">
                <ActivityIndicator size="large" />
                <Text className="mt-4 text-muted-foreground">Loading plans...</Text>
              </View>
            ) : (
              tierGroups.map((group, index) => {
                const { tier, monthly, yearly } = group;
                const tierId = tier.id;
                const isFree = tierId === 'free';
                const hasYearly = hasYearlyOption(tierId) && yearly;
                const selectedBilling = getTierBilling(tierId);
                
                // Get the option based on selected billing period
                const option = selectedBilling === 'yearly' && hasYearly ? yearly : monthly;
                if (!option) return null;
                
                const isSelected = selectedPlanOption?.tier.id === option.tier.id && 
                                  selectedPlanOption?.commitmentType === option.commitmentType;
                const isCurrent = isCurrentPlan(option);
                const isScheduledTarget = isScheduledTargetPlan(option);
                const credits = parseCreditsFromFeatures(option.tier.features);
                const keyFeatures = getKeyFeatures(option.tier.features, 4, isFree);
                const dailyCredits = isFree ? 200 : null;

                return (
                  <Pressable
                    key={tierId}
                    onPress={() => {
                    if (!isCurrent && !isScheduledTarget) {
                        handlePlanSelect(option);
                      }
                    }}
                    className={`mb-4 rounded-[18px] overflow-hidden border-2 ${
                      isSelected 
                        ? 'bg-primary/10 border-primary' 
                        : isScheduledTarget
                          ? 'bg-yellow-500/5 border-yellow-500/30'
                          : isFree 
                            ? 'bg-muted/30 border-border/30' 
                            : 'bg-card border-border/30'
                    } ${!option.isAvailable ? 'opacity-60' : ''}`}
                  >
                    {/* Header Section */}
                    <View className="p-4 pb-3">
                      <View className="flex-row items-start justify-between">
                        {/* Left: Name + Badges */}
                      <View className="flex-1">
                          <View className="flex-row items-center gap-2 flex-wrap mb-1">
                            <Text className="text-lg font-roobert-semibold text-foreground">
                              {tier.name}
                          </Text>
                            {isCurrent && (
                              <View className="bg-primary/10 rounded-full px-2 py-0.5">
                                <Text className="text-[10px] font-roobert-medium text-primary">
                                  {t('billing.current', 'Current')}
                                </Text>
                              </View>
                            )}
                            {isScheduledTarget && (
                              <View className="bg-yellow-500/10 rounded-full px-2 py-0.5">
                                <Text className="text-[10px] font-roobert-medium" style={{ color: isDark ? '#fbbf24' : '#d97706' }}>
                                  {t('billing.scheduledBadge', 'Scheduled')}
                                </Text>
                              </View>
                            )}
                          </View>
                          
                          {/* Billing Toggle - only for non-free tiers with yearly option */}
                          {hasYearly && (
                            <Pressable 
                              onPress={(e) => {
                                e.stopPropagation();
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                const newBilling = selectedBilling === 'monthly' ? 'yearly' : 'monthly';
                                setTierBillingPeriod(prev => ({ ...prev, [tierId]: newBilling }));
                                // Auto-select this option when switching billing
                                const newOption = newBilling === 'yearly' ? yearly : monthly;
                                if (newOption) {
                                  handlePlanSelect(newOption);
                                }
                              }}
                              className="flex-row items-center gap-2 mt-2"
                            >
                              {/* Toggle Label - Left */}
                              <Text className={`text-xs font-roobert-medium ${
                                selectedBilling === 'monthly' ? 'text-foreground' : 'text-muted-foreground'
                              }`}>
                                Monthly
                              </Text>
                              {/* Toggle Switch */}
                              <View 
                                className={`w-11 h-6 rounded-full p-0.5 ${
                                  selectedBilling === 'yearly' ? 'bg-primary' : 'bg-muted'
                                }`}
                              >
                                <View 
                                  className={`w-5 h-5 rounded-full bg-white shadow-sm ${
                                    selectedBilling === 'yearly' ? 'ml-auto' : ''
                                  }`}
                                />
                            </View>
                              {/* Toggle Label - Right */}
                              <Text className={`text-xs font-roobert-medium ${
                                selectedBilling === 'yearly' ? 'text-foreground' : 'text-muted-foreground'
                              }`}>
                                Annual
                              </Text>
                            </Pressable>
                          )}
                      </View>

                        {/* Right: Price */}
                        <View className="items-end">
                          <Text className="text-2xl font-roobert-semibold text-foreground">
                            {option.price}
                          </Text>
                          {option.commitmentType === 'yearly_commitment' && option.price !== '$0' && (
                            <Text className="text-xs text-muted-foreground mt-0.5">
                              /year
                            </Text>
                          )}
                          {option.commitmentType === 'monthly' && option.price !== '$0' && (
                            <Text className="text-xs text-muted-foreground mt-0.5">
                              /month
                            </Text>
                          )}
                        </View>
                      </View>
                    </View>

                    {/* Credits Section */}
                    <View className="px-4 pb-3">
                      {isFree ? (
                        <View className="flex-row items-start gap-3">
                          <View className="w-5 h-5 items-center justify-center mt-0.5">
                            <Icon as={Check} size={16} className="text-primary" strokeWidth={2.5} />
                          </View>
                          <View className="flex-1">
                            <Text className="text-sm font-roobert-medium text-foreground">
                              {dailyCredits} Daily Credits
                            </Text>
                            <Text className="text-xs text-muted-foreground mt-0.5">
                              Refreshes every 24 hours (applies to all tiers)
                            </Text>
                          </View>
                        </View>
                      ) : credits ? (
                        <View className="flex-row items-start gap-3">
                          <View className="w-5 h-5 items-center justify-center mt-0.5">
                            <Icon as={Check} size={16} className="text-primary" strokeWidth={2.5} />
                          </View>
                          <View className="flex-1">
                            <View className="flex-row items-center gap-2 flex-wrap">
                              <Text className="text-sm text-muted-foreground line-through">
                                {credits.base.toLocaleString()}
                              </Text>
                              <Text className="text-sm font-roobert-bold text-primary">
                                {credits.total.toLocaleString()}
                              </Text>
                              <Text className="text-sm font-roobert-medium text-foreground">
                                Monthly Credits
                              </Text>
                              <View className="bg-gradient-to-r px-2 py-0.5 rounded-md" style={{ backgroundColor: isDark ? 'rgba(251, 191, 36, 0.15)' : 'rgba(251, 191, 36, 0.1)' }}>
                                <Text className="text-[10px] font-roobert-bold" style={{ color: isDark ? '#fbbf24' : '#d97706' }}>
                                  2x BONUS
                                </Text>
                              </View>
                            </View>
                            <Text className="text-xs text-muted-foreground mt-0.5">
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
                              <View className="w-5 h-5 items-center justify-center mt-0.5">
                                <Icon as={Check} size={16} className="text-primary" strokeWidth={2.5} />
                              </View>
                              <View className="flex-1">
                                <Text className="text-sm font-roobert-medium text-foreground">
                                  {feature.text}
                                </Text>
                                {feature.description && (
                                  <Text className="text-xs text-muted-foreground mt-0.5">
                                    {feature.description}
                                  </Text>
                                )}
                              </View>
                            </View>
                          ))}
                        </View>
                        
                        {/* Disabled features for free tier */}
                        {isFree && tier.disabledFeatures && tier.disabledFeatures.length > 0 && (
                          <View className="mt-3 pt-3 border-t border-border/50 space-y-2">
                            {tier.disabledFeatures.map((feature, idx) => (
                              <View key={idx} className="flex-row items-center gap-3 opacity-50">
                                <Icon as={X} size={16} className="text-muted-foreground" strokeWidth={2} />
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
                        <View className="bg-primary/10 rounded-lg px-3 py-2">
                          <Text className="text-xs font-roobert-medium text-primary text-center">
                            🎉 {option.package.product.introPrice.priceString} for first {option.package.product.introPrice.period}
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
          <AnimatedView 
            entering={FadeIn.duration(600).delay(200)} 
            className="px-6 mb-6"
          >
            <View className="bg-card border border-border rounded-[18px] p-5">
              <View className="flex-row items-start gap-4">
                <View className="bg-primary/10 rounded-full p-2.5">
                  <Icon
                    as={AlertCircle}
                    size={20}
                    className="text-primary"
                    strokeWidth={2}
                  />
                </View>
                <View className="flex-1">
                  <Text className="text-base font-roobert-semibold text-foreground mb-1">
                  {t('billing.webSubscriptionActive', 'Web Subscription Active')}
                </Text>
                  <Text className="text-sm text-muted-foreground leading-relaxed">
                  {t('billing.stripeSubscriberMessage', 'You have a web subscription. Please manage your plan on the web platform where you upgraded.')}
                </Text>
                </View>
              </View>
            </View>
          </AnimatedView>
        )}

      </AnimatedScrollView>

      {/* Purchase Button & Footer */}
      {!isStripeSubscriber && (() => {
        const selectedPlan = selectedPlanOption;
        const isCurrent = selectedPlan ? isCurrentPlan(selectedPlan) : false;
        const isScheduledTarget = selectedPlan ? isScheduledTargetPlan(selectedPlan) : false;
        const isDisabled = isPurchasing || isCurrent || isScheduledTarget;
        
        return (
        <AnimatedView 
          entering={FadeIn.duration(600).delay(500)} 
            className="px-6 py-4 bg-background border-t border-border/50"
            style={{ paddingBottom: insets.bottom + 8 }}
        >
            {selectedPlan ? (
              <AnimatedView
                style={[
                  purchaseButtonStyle,
                  {
                    opacity: isDisabled ? 0.5 : 1,
                  }
                ]}
              >
                <Pressable
              onPress={handlePurchase}
                  disabled={isDisabled}
              onPressIn={() => {
                    if (!isPurchasing && !isDisabled) {
                  purchaseButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                }
              }}
              onPressOut={() => {
                purchaseButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
                  className={`w-full h-12 rounded-xl items-center justify-center ${
                    isDisabled
                      ? 'bg-primary/5' 
                      : 'bg-primary'
              }`}
            >
              {isPurchasing ? (
                    <ActivityIndicator color={isDark ? '#fff' : '#000'} />
              ) : (
                    <Text className={`text-sm font-roobert-medium ${
                      isDisabled ? 'text-primary' : 'text-primary-foreground'
                }`}>
                      {isCurrent 
                        ? t('billing.currentPlan', 'Current Plan')
                        : isScheduledTarget
                          ? t('billing.scheduled', 'Scheduled')
                          : selectedPlan.tier.id === 'free'
                            ? t('billing.selectPlan', 'Select Plan')
                            : t('billing.upgrade', 'Upgrade')
                      }
                </Text>
              )}
                </Pressable>
              </AnimatedView>
          ) : (
              <View className="w-full h-12 rounded-xl items-center justify-center bg-muted">
                <Text className="text-sm font-roobert-medium text-muted-foreground">
                {t('billing.selectPlan', 'Select a plan')}
              </Text>
            </View>
          )}

            {error && (
              <View className="mt-3 bg-destructive/10 rounded-lg px-4 py-2">
                <Text className="text-sm text-destructive text-center font-roobert-medium">
                  {error}
                </Text>
              </View>
            )}

            <View className="flex-row justify-center mt-4 gap-4">
              <Pressable onPress={() => WebBrowser.openBrowserAsync('https://www.kortix.com/privacy')}>
                <Text className="text-xs text-muted-foreground font-roobert-medium">
                {t('billing.privacyPolicy', 'Privacy Policy')}
              </Text>
            </Pressable>
              <Pressable onPress={() => WebBrowser.openBrowserAsync('https://www.kortix.com/terms')}>
                <Text className="text-xs text-muted-foreground font-roobert-medium">
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
