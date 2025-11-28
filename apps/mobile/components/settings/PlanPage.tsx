/**
 * Plan Page Component
 * 
 * Matches RevenueCatPricingSection style exactly
 * Selection-based with purchase button
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Linking, Platform } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, AlertCircle } from 'lucide-react-native';
import { PRICING_TIERS, type BillingPeriod, type PricingTier } from '@/lib/billing';
import { useRevenueCatPricing } from '@/lib/billing';
import { startUnifiedPlanCheckout } from '@/lib/billing/unified-checkout';
import { useSubscription, useSubscriptionCommitment, billingKeys, invalidateCreditsAfterPurchase } from '@/lib/billing';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { purchasePackage } from '@/lib/billing/revenuecat';
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
import { KortixLogo } from '../ui/KortixLogo';
import BottomSheet, { BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import type { PurchasesPackage } from 'react-native-purchases';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

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
  const [showExistingSubDrawer, setShowExistingSubDrawer] = useState(false);

  const existingSubDrawerRef = useRef<BottomSheet>(null);
  const closeButtonScale = useSharedValue(1);
  const purchaseButtonScale = useSharedValue(1);

  const closeButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeButtonScale.value }],
  }));

  const purchaseButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: purchaseButtonScale.value }],
  }));

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  const handleCloseExistingSubDrawer = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowExistingSubDrawer(false);
  }, []);

  useEffect(() => {
    if (showExistingSubDrawer) {
      existingSubDrawerRef.current?.snapToIndex(0);
    } else {
      existingSubDrawerRef.current?.close();
    }
  }, [showExistingSubDrawer]);

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

  // Sort by price
  planOptions.sort((a, b) => a.priceNumber - b.priceNumber);

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
        await purchasePackage(selectedPlanOption.package, user?.email, user?.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        queryClient.invalidateQueries({ queryKey: billingKeys.all });
        invalidateCreditsAfterPurchase(queryClient);
        await refetchSubscription();
        onPurchaseComplete?.();
        onClose?.();
        return;
      }

      // Fallback to unified checkout
      await startUnifiedPlanCheckout(
        selectedPlanOption.tier.id,
        selectedPlanOption.commitmentType,
        () => {
          handleSubscriptionUpdate();
          onPurchaseComplete?.();
          onClose?.();
        },
        () => {}
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
        // Apple ID already has a subscription on another account - show drawer
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setShowExistingSubDrawer(true);
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

  const getCurrentProvider = (): 'stripe' | 'revenuecat' | null => {
    if (!isAuthenticated || !subscriptionData) return null;
    return subscriptionData.provider as 'stripe' | 'revenuecat' | null;
  };

  const getPackageType = (option: PlanOption): string => {
    if (option.commitmentType === 'yearly_commitment') {
      return 'Yearly';
    }
    return 'Monthly';
  };

  const currentProvider = getCurrentProvider();
  const currentTierKey = subscriptionData?.tier_key;
  const isStripeSubscriber = currentProvider === 'stripe' && currentTierKey && currentTierKey !== 'free';
  const isRevenueCatSubscriber = currentProvider === 'revenuecat';

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose?.();
  }, [onClose]);

  if (!visible) return null;

  return (
    <View className="flex-1 bg-background">
      {onClose && (
        <AnimatedView 
          entering={FadeIn.duration(400)}
          className="px-6 flex-row justify-between items-center bg-background border-b border-border/30"
          style={{ paddingTop: insets.top + 16, paddingBottom: 16 }}
        >
          <KortixLogo variant="logomark" size={72} color={isDark ? 'dark' : 'light'} />
          <AnimatedPressable
            onPress={handleClose}
            onPressIn={() => {
              closeButtonScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              closeButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            style={closeButtonStyle}
            className="h-10 w-10 rounded-full bg-primary/10 items-center justify-center"
          >
            <Icon as={X} size={18} className="text-foreground" strokeWidth={2.5} />
          </AnimatedPressable>
        </AnimatedView>
      )}

      <AnimatedScrollView 
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ 
          paddingTop: 16,
          paddingBottom: 16
        }}
      >
        <AnimatedView 
          entering={FadeIn.duration(600).delay(50)} 
          className="px-6 mb-4"
        >
          <Text className="text-2xl font-roobert-semibold text-foreground text-center">
            {customTitle || t('billing.pickPlan', 'Pick the plan that works for you')}
          </Text>
        </AnimatedView>

        {/* Plan List - Simple Radio Button Style */}
        {/* Hide plans if user has Stripe subscription */}
        {!isStripeSubscriber && (
          <AnimatedView 
            entering={FadeIn.duration(600).delay(200)} 
            className="px-6 mb-6"
          >
            {isLoadingPricing && useRevenueCat ? (
              <View className="py-12 items-center">
                <ActivityIndicator size="large" />
                <Text className="mt-4 text-muted-foreground">Loading plans...</Text>
              </View>
            ) : (
              planOptions.map((option, index) => {
                const optionKey = `${option.tier.id}_${option.commitmentType}`;
                const isSelected = selectedPlanOption?.tier.id === option.tier.id && 
                                  selectedPlanOption?.commitmentType === option.commitmentType;
                const isCurrent = isCurrentPlan(option);
                const packageType = getPackageType(option);

                return (
                  <AnimatedPressable
                    key={optionKey}
                    entering={FadeIn.duration(600).delay(300 + index * 100)}
                    onPress={() => {
                      if (!isCurrent) {
                        handlePlanSelect(option);
                      }
                    }}
                    className={`mb-3 border-[1px] rounded-3xl p-4 ${
                      isSelected 
                        ? 'border-foreground bg-muted/20' 
                        : 'border-border/60 bg-transparent'
                    } ${!option.isAvailable ? 'opacity-60' : ''}`}
                  >
                    <View className="flex-row items-center">
                      <View 
                        className={`w-6 h-6 rounded-full border-2 items-center justify-center mr-4 ${
                          isSelected 
                            ? 'border-foreground bg-foreground' 
                            : 'border-border/60 bg-transparent'
                        }`}
                      >
                        {isSelected && (
                          <View className="w-3 h-3 rounded-full bg-background" />
                        )}
                      </View>
                      
                      <View className="flex-1">
                        <View className="flex-row items-center gap-2 mb-1">
                          <Text className="text-base font-roobert-semibold text-foreground">
                            {option.tier.name}
                          </Text>
                          {isCurrent && (
                            <View className="bg-green-500 rounded-full px-2 py-0.5">
                              <Text className="text-[10px] font-roobert-semibold text-white uppercase tracking-wide">
                                {t('billing.current', 'Current')}
                              </Text>
                            </View>
                          )}
                          {!isCurrent && option.tier.isPopular && (
                            <View className="bg-primary rounded-full px-2 py-0.5">
                              <Text className="text-[10px] font-roobert-semibold text-primary-foreground uppercase tracking-wide">
                                {t('billing.popular', 'Popular')}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Text className="text-sm text-muted-foreground">
                          {packageType}
                        </Text>
                      </View>

                      <View className="items-end">
                        <View className="items-end">
                          <Text className="text-lg font-roobert-semibold text-foreground">
                            {option.price}
                          </Text>
                          {option.commitmentType === 'yearly_commitment' && option.price !== '$0' && (
                            <Text className="text-xs text-muted-foreground mt-0.5">
                              /year
                            </Text>
                          )}
                        </View>
                      </View>
                    </View>

                    {option.package?.product.introPrice && (
                      <View className="mt-2 ml-10 bg-primary/10 rounded-lg px-3 py-2">
                        <Text className="text-xs font-roobert-medium text-primary">
                          {option.package.product.introPrice.priceString} for {option.package.product.introPrice.period}
                        </Text>
                      </View>
                    )}
                  </AnimatedPressable>
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
            <View className="bg-blue-500/10 border-2 border-blue-500/30 rounded-[18px] p-6">
              <View className="items-center mb-4">
                <View className="bg-blue-500/20 rounded-full p-3 mb-3">
                  <Icon
                    as={AlertCircle}
                    size={24}
                    className="text-blue-600 dark:text-blue-400"
                    strokeWidth={2}
                  />
                </View>
                <Text className="text-lg font-roobert-semibold text-blue-600 dark:text-blue-400 text-center mb-2">
                  {t('billing.webSubscriptionActive', 'Web Subscription Active')}
                </Text>
                <Text className="text-sm font-roobert-medium text-blue-600/80 dark:text-blue-400/80 text-center">
                  {t('billing.stripeSubscriberMessage', 'You have a web subscription. Please manage your plan on the web platform where you upgraded.')}
                </Text>
              </View>
            </View>
          </AnimatedView>
        )}

      </AnimatedScrollView>

      {/* Purchase Button & Footer */}
      {!isStripeSubscriber && (
        <AnimatedView 
          entering={FadeIn.duration(600).delay(500)} 
          className="px-6 py-4 bg-background border-t border-border/30"
        >
          {selectedPlanOption ? (
            <AnimatedPressable
              onPress={handlePurchase}
              disabled={isPurchasing || isCurrentPlan(selectedPlanOption)}
              onPressIn={() => {
                if (!isPurchasing && !isCurrentPlan(selectedPlanOption)) {
                  purchaseButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                }
              }}
              onPressOut={() => {
                purchaseButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
              style={[
                purchaseButtonStyle,
                {
                  opacity: isPurchasing || isCurrentPlan(selectedPlanOption) ? 0.5 : 1,
                }
              ]}
              className={`w-full h-14 rounded-2xl items-center justify-center ${
                isPurchasing || isCurrentPlan(selectedPlanOption)
                  ? 'bg-muted' 
                  : 'bg-foreground'
              }`}
            >
              {isPurchasing ? (
                <ActivityIndicator color={isDark ? '#000' : '#fff'} />
              ) : (
                <Text className={`text-base font-roobert-semibold ${
                  isCurrentPlan(selectedPlanOption) ? 'text-muted-foreground' : 'text-background'
                }`}>
                  {isCurrentPlan(selectedPlanOption) ? t('billing.currentPlan', 'Current Plan') : t('billing.continue', 'Continue')}
                </Text>
              )}
            </AnimatedPressable>
          ) : (
            <View className="w-full h-14 rounded-2xl items-center justify-center bg-muted/50">
              <Text className="text-base font-roobert-semibold text-muted-foreground">
                {t('billing.selectPlan', 'Select a plan')}
              </Text>
            </View>
          )}

          <View className="flex-row justify-center mt-6 gap-6 mb-2">
            <Pressable onPress={() => Linking.openURL('https://kortix.ai/privacy')}>
              <Text className="text-xs text-muted-foreground/70 font-roobert-medium underline">
                {t('billing.privacyPolicy', 'Privacy Policy')}
              </Text>
            </Pressable>
            <Pressable onPress={() => Linking.openURL('https://kortix.ai/terms')}>
              <Text className="text-xs text-muted-foreground/70 font-roobert-medium underline">
                {t('billing.termsOfService', 'Terms of Service')}
              </Text>
            </Pressable>
          </View>

          {error && (
            <Text className="text-sm text-red-500 text-center mt-2">
              {error}
            </Text>
          )}
        </AnimatedView>
      )}

      {/* Existing Subscription Drawer */}
      <BottomSheet
        ref={existingSubDrawerRef}
        index={-1}
        enablePanDownToClose
        enableDynamicSizing
        backdropComponent={renderBackdrop}
        backgroundStyle={{
          backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
        }}
        onClose={handleCloseExistingSubDrawer}
      >
        <BottomSheetView style={{ paddingBottom: insets.bottom + 24 }}>
          <View className="px-6 py-6">
            <View className="items-center mb-4">
              <View className="w-16 h-16 rounded-full bg-amber-500/10 items-center justify-center mb-4">
                <Icon as={AlertCircle} size={32} className="text-amber-500" strokeWidth={2} />
              </View>
              <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
                {t('billing.subscriptionExists', 'Already Subscribed')}
              </Text>
              <Text className="text-base text-muted-foreground text-center leading-relaxed">
                {Platform.OS === 'ios' 
                  ? 'You are already subscribed with a different account on this Apple ID.'
                  : 'You are already subscribed with a different account on this Google Play ID.'}
              </Text>
            </View>

            <View className="bg-primary/5 rounded-2xl p-4 mb-4">
              <Text className="text-sm text-foreground text-center leading-relaxed">
                {t('billing.subscriptionExistsHelp', 'Please log into your original account to access your subscription.')}
              </Text>
            </View>

            <Pressable
              onPress={handleCloseExistingSubDrawer}
              className="w-full h-12 bg-foreground rounded-2xl items-center justify-center"
            >
              <Text className="text-base font-roobert-semibold text-background">
                {t('billing.gotIt', 'Got it')}
              </Text>
            </Pressable>
          </View>
        </BottomSheetView>
      </BottomSheet>
    </View>
  );
}
