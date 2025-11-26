import React, { useState, useEffect, useCallback } from 'react';
import { View, Linking, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ShoppingCart, Lightbulb, X, Clock, Infinity } from 'lucide-react-native';
import { PricingTierCard } from './PricingTierCard';
import { CreditPurchaseModal } from './CreditPurchaseModal';
import { PRICING_TIERS, getDisplayPrice, type BillingPeriod, type PricingTier } from '@/lib/billing';
import { useSubscription, useSubscriptionCommitment, billingKeys } from '@/lib/billing';
import { startUnifiedPlanCheckout } from '@/lib/billing/unified-checkout';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { getOfferings } from '@/lib/billing/revenuecat';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import { KortixLogo } from '../ui/KortixLogo';
import { useColorScheme } from 'nativewind';
import type { PurchasesOffering } from 'react-native-purchases';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

interface PricingSectionProps {
  returnUrl?: string;
  showTitleAndTabs?: boolean;
  hideFree?: boolean;
  insideDialog?: boolean;
  noPadding?: boolean;
  onSubscriptionUpdate?: () => void;
  customTitle?: string;
  onClose?: () => void;
}

export function PricingSection({
  returnUrl,
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false,
  noPadding = false,
  onSubscriptionUpdate,
  customTitle,
  onClose,
}: PricingSectionProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const { data: subscriptionData, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useSubscription({ enabled: isUserAuthenticated });
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription?.id, {
    enabled: isUserAuthenticated
  });

  const isAuthenticated = isUserAuthenticated && !!subscriptionData && subscriptionQueryError === null;
  const currentSubscription = subscriptionData || null;

  // Determine current subscription's billing period (matching frontend exactly)
  // Note: Mobile only supports 'monthly' | 'yearly_commitment', so we map 'yearly' to 'yearly_commitment'
  const getCurrentBillingPeriod = (): BillingPeriod | null => {
    if (!isAuthenticated || !currentSubscription) {
      return null;
    }

    // Use billing_period from API response (most reliable - comes from price_id)
    if (currentSubscription.billing_period) {
      const period = currentSubscription.billing_period;
      // Map 'yearly' to 'yearly_commitment' for mobile
      return period === 'yearly' ? 'yearly_commitment' : period as BillingPeriod;
    }

    // Fallback: Check commitment info
    if (subCommitmentQuery.data?.has_commitment &&
      subCommitmentQuery.data?.commitment_type === 'yearly_commitment') {
      return 'yearly_commitment';
    }

    // Fallback: Try to infer from period length
    if (currentSubscription.subscription?.current_period_end) {
      const periodEnd = typeof currentSubscription.subscription.current_period_end === 'number'
        ? currentSubscription.subscription.current_period_end * 1000
        : new Date(currentSubscription.subscription.current_period_end).getTime();

      const now = Date.now();
      const daysInPeriod = Math.round((periodEnd - now) / (1000 * 60 * 60 * 24));

      // If period is longer than 180 days, likely yearly; otherwise monthly
      if (daysInPeriod > 180) {
        return 'yearly_commitment';
      }
    }

    // Default to monthly if period is short or can't determine
    return 'monthly';
  };

  const currentBillingPeriod = getCurrentBillingPeriod();

  const getDefaultBillingPeriod = useCallback((): BillingPeriod => {
    if (!isAuthenticated || !currentSubscription) {
      return 'yearly_commitment';
    }

    // Use current subscription's billing period if available, otherwise default to yearly_commitment
    return currentBillingPeriod || 'yearly_commitment';
  }, [isAuthenticated, currentSubscription, currentBillingPeriod]);

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(getDefaultBillingPeriod());
  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});
  const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);
  const [revenueCatOfferings, setRevenueCatOfferings] = useState<PurchasesOffering | null>(null);
  const [isLoadingOfferings, setIsLoadingOfferings] = useState(false);
  const [mergedTiers, setMergedTiers] = useState<PricingTier[]>(PRICING_TIERS);

  const useRevenueCat = shouldUseRevenueCat() && isRevenueCatConfigured();

  useEffect(() => {
    setBillingPeriod(getDefaultBillingPeriod());
  }, [getDefaultBillingPeriod]);

  // Load RevenueCat offerings and merge with hardcoded tier data
  useEffect(() => {
    if (!useRevenueCat) {
      setMergedTiers(PRICING_TIERS);
      return;
    }

    const loadOfferings = async () => {
      try {
        setIsLoadingOfferings(true);
        const offerings = await getOfferings(true);
        setRevenueCatOfferings(offerings);

        if (offerings?.availablePackages) {
          // Group packages by tier to handle monthly/yearly variants
          const tierMap = new Map<string, { monthly?: typeof offerings.availablePackages[0], yearly?: typeof offerings.availablePackages[0] }>();

          offerings.availablePackages.forEach((pkg) => {
            const matchingTier = PRICING_TIERS.find((tier) =>
              tier.revenueCatId && pkg.product.identifier.includes(tier.revenueCatId)
            );

            if (matchingTier) {
              const existing = tierMap.get(matchingTier.id) || {};

              // Determine if this is monthly or yearly based on product identifier
              if (pkg.product.identifier.includes('yearly')) {
                existing.yearly = pkg;
              } else if (pkg.product.identifier.includes('monthly')) {
                existing.monthly = pkg;
              }

              tierMap.set(matchingTier.id, existing);
            }
          });

          // Merge RevenueCat packages with hardcoded tier data
          const merged = PRICING_TIERS.map((tier) => {
            const packages = tierMap.get(tier.id);
            if (!packages) return tier; // No RC data, use hardcoded

            const monthlyPkg = packages.monthly;
            const yearlyPkg = packages.yearly;

            // Use RevenueCat pricing, keep hardcoded features/metadata
            return {
              ...tier,
              price: monthlyPkg?.product.priceString || tier.price,
              priceMonthly: monthlyPkg?.product.price || tier.priceMonthly,
              priceYearly: yearlyPkg?.product.price || tier.priceYearly,
            } as PricingTier;
          });

          setMergedTiers(merged);
        }
      } catch (error) {
        console.error('Failed to load RevenueCat offerings:', error);
        setMergedTiers(PRICING_TIERS);
      } finally {
        setIsLoadingOfferings(false);
      }
    };

    loadOfferings();
  }, [useRevenueCat]);

  const handlePlanSelect = (planId: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }));
  };

  const handleSubscriptionUpdate = () => {
    // Invalidate all billing-related queries to force refetch
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    // Also refetch subscription and commitment directly
    refetchSubscription();
    subCommitmentQuery.refetch();
    // Clear loading states
    setTimeout(() => {
      setPlanLoadingStates({});
    }, 1000);
    // Call parent's update handler if provided
    if (onSubscriptionUpdate) {
      onSubscriptionUpdate();
    }
  };

  const handleSubscribe = async (tierKey: string, isDowngrade = false) => {
    if (!isAuthenticated) {
      return;
    }

    if (planLoadingStates[tierKey]) {
      return;
    }

    try {
      handlePlanSelect(tierKey);
      const commitmentType = billingPeriod === 'yearly_commitment' ? 'yearly_commitment' : 'monthly';

      await startUnifiedPlanCheckout(
        tierKey,
        commitmentType,
        () => {
          handleSubscriptionUpdate();
          setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
        },
        () => {
          setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
        }
      );
    } catch (error) {
      console.error('❌ Error processing subscription:', error);
      setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
    }
  };

  const tiersToShow = mergedTiers.filter(
    (tier) => tier.hidden !== true && (!hideFree || tier.price !== '$0')
  );

  const creditsButtonScale = useSharedValue(1);
  const creditsLinkScale = useSharedValue(1);
  const closeButtonScale = useSharedValue(1);

  const creditsButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsButtonScale.value }],
  }));

  const creditsLinkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsLinkScale.value }],
  }));

  const closeButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeButtonScale.value }],
  }));

  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <View className={`flex-1 ${noPadding ? 'pb-0' : ''}`}>
      {onClose && (
        <AnimatedView
          entering={FadeIn.duration(400)}
          className="px-6 -mt-6 flex-row justify-between items-center bg-background border-b border-border/30"
          style={{ paddingTop: insets.top + 16 }}
        >
          <View>
            <KortixLogo variant="logomark" size={72} color={isDark ? 'dark' : 'light'} />
          </View>
          <AnimatedPressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onClose();
            }}
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
          paddingBottom: 100
        }}
        bounces={true}
      >
        <AnimatedView
          entering={FadeIn.duration(600).delay(50)}
          className="px-6 mb-4 flex flex-col items-center"
        >
          <Text className="text-2xl font-roobert-semibold text-foreground mb-4">
            {customTitle || t('billing.choosePlan')}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <AnimatedPressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setBillingPeriod('monthly');
              }}
              className={`px-4 py-2 rounded-full ${billingPeriod === 'monthly'
                ? 'bg-foreground'
                : 'border border-border bg-transparent'
                }`}
            >
              <Text
                className={`text-sm font-roobert-medium ${billingPeriod === 'monthly'
                  ? 'text-background'
                  : 'text-foreground'
                  }`}
              >
                {t('billing.monthly')}
              </Text>
            </AnimatedPressable>

            <AnimatedPressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setBillingPeriod('yearly_commitment');
              }}
              className={`px-4 py-2 rounded-full flex-row items-center gap-1.5 ${billingPeriod === 'yearly_commitment'
                ? 'bg-foreground'
                : 'border border-border bg-transparent'
                }`}
            >
              <Text
                className={`text-sm font-roobert-medium ${billingPeriod === 'yearly_commitment'
                  ? 'text-background'
                  : 'text-foreground'
                  }`}
              >
                {t('billing.yearlyCommitment')}
              </Text>
              <View className={`px-1.5 py-0.5 rounded-full ${billingPeriod === 'yearly_commitment'
                ? 'bg-primary-foreground/20'
                : 'bg-primary/20'
                }`}>
                <Text className={`text-[10px] font-roobert-semibold ${billingPeriod === 'yearly_commitment'
                  ? 'text-background'
                  : 'text-primary'
                  }`}>
                  {t('billing.save15Percent')}
                </Text>
              </View>
            </AnimatedPressable>
          </View>
        </AnimatedView>

        {/* Horizontal scrolling pricing cards */}
        <AnimatedView
          entering={FadeIn.duration(600).delay(200)}
          className="mb-6"
        >
          {isLoadingOfferings ? (
            <View className="h-[400px] items-center justify-center">
              <ActivityIndicator size="large" />
              <Text className="text-sm text-muted-foreground mt-4">Loading plans...</Text>
            </View>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 4 }}
              decelerationRate="fast"
              snapToInterval={296}
              snapToAlignment="start"
            >
              {tiersToShow.map((tier, index) => {
                const displayPrice = getDisplayPrice(tier, billingPeriod);

                return (
                  <PricingTierCard
                    key={tier.id}
                    tier={tier}
                    displayPrice={displayPrice}
                    billingPeriod={billingPeriod}
                    currentSubscription={currentSubscription}
                    isLoading={planLoadingStates[tier.id] || false}
                    isFetchingPlan={isFetchingPlan}
                    onPlanSelect={handlePlanSelect}
                    onSubscribe={handleSubscribe}
                    onSubscriptionUpdate={handleSubscriptionUpdate}
                    isAuthenticated={isAuthenticated}
                    currentBillingPeriod={currentBillingPeriod}
                    t={t}
                    index={index}
                  />
                );
              })}
            </ScrollView>
          )}
        </AnimatedView>
        {/* Billing Status Card */}
        {isAuthenticated && currentSubscription && (
          <AnimatedView
            entering={FadeIn.duration(600).delay(400)}
            className="px-6 mb-6"
          >
            <View className="bg-card border border-border rounded-[18px] p-6">
              {/* Get Additional Credits Button */}
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
                className="w-full h-12 border border-border rounded-2xl items-center justify-center flex-row gap-2 mb-6 bg-transparent"
              >
                <Icon as={ShoppingCart} size={18} className="text-foreground" strokeWidth={2} />
                <Text className="text-sm font-roobert-semibold text-foreground">
                  Get Additional Credits
                </Text>
              </AnimatedPressable>

              {/* Billing Status */}
              <View className="mb-6">
                <Text className="text-xl font-roobert-semibold text-foreground mb-4">
                  Billing Status
                </Text>
                <View>
                  <Text className="text-[32px] font-roobert-semibold text-foreground leading-tight">
                    ${((currentSubscription?.credits?.balance || 0) / 100).toFixed(2)}
                  </Text>
                  <Text className="text-sm text-muted-foreground font-roobert mt-1">
                    Total Available Usage
                  </Text>
                </View>
              </View>

              {/* Credit Details */}
              <View className="gap-3 mb-4">
                <View className="flex-row items-center justify-between py-3 px-4 border border-border/50 rounded-xl">
                  <View className="flex-row items-center gap-2">
                    <Icon as={Clock} size={16} className="text-orange-500" strokeWidth={2} />
                    <Text className="text-sm font-roobert-medium text-foreground">
                      Monthly Credits
                    </Text>
                  </View>
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    ${((currentSubscription?.credits?.balance || 0) / 100).toFixed(2)}
                  </Text>
                </View>

                <View className="flex-row items-center justify-between py-3 px-4 border border-border/50 rounded-xl">
                  <View className="flex-row items-center gap-2">
                    <Icon as={Infinity} size={16} className="text-foreground" strokeWidth={2} />
                    <Text className="text-sm font-roobert-medium text-foreground">
                      Credits
                    </Text>
                  </View>
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    ${((currentSubscription?.credits?.balance || 0) / 100).toFixed(2)}
                  </Text>
                </View>
              </View>

              {/* See How Model Pricing Works */}
              <AnimatedPressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  Linking.openURL('https://kortix.com/help/credits-explained');
                }}
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
                  See how Model Pricing works
                </Text>
              </AnimatedPressable>
            </View>
          </AnimatedView>
        )}
      </AnimatedScrollView>

      <CreditPurchaseModal
        open={showCreditPurchaseModal}
        onOpenChange={setShowCreditPurchaseModal}
        currentBalance={currentSubscription?.credits?.balance || 0}
        canPurchase={currentSubscription?.credits?.can_purchase_credits || false}
        onPurchaseComplete={handleSubscriptionUpdate}
      />
    </View>
  );
}
