/**
 * Pricing Section Component
 * 
 * Matches frontend's PricingSection component exactly
 * Uses hooks directly like frontend (no context)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ShoppingCart, Lightbulb } from 'lucide-react-native';
import { BillingPeriodToggle } from './BillingPeriodToggle';
import { PricingTierCard } from './PricingTierCard';
import { CreditPurchaseModal } from './CreditPurchaseModal';
import { PRICING_TIERS, getDisplayPrice, type PricingTier, type BillingPeriod } from '@/lib/billing';
import { useSubscription, useSubscriptionCommitment, billingKeys } from '@/lib/billing';
import { billingApi, type CreateCheckoutSessionRequest } from '@/lib/billing/api';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  FadeIn,
  withDelay,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

interface PricingSectionProps {
  returnUrl?: string;
  showTitleAndTabs?: boolean;
  hideFree?: boolean;
  insideDialog?: boolean;
  noPadding?: boolean;
  onSubscriptionUpdate?: () => void;
  customTitle?: string;
}

export function PricingSection({
  returnUrl,
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false,
  noPadding = false,
  onSubscriptionUpdate,
  customTitle,
}: PricingSectionProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();

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

  useEffect(() => {
    setBillingPeriod(getDefaultBillingPeriod());
  }, [getDefaultBillingPeriod]);

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
      // Mobile: Navigate to auth
      return;
    }

    if (planLoadingStates[tierKey]) {
      return;
    }

    try {
      handlePlanSelect(tierKey);
      const commitmentType = billingPeriod === 'yearly_commitment' ? 'yearly_commitment' : 'monthly';

      const request: CreateCheckoutSessionRequest = {
        tier_key: tierKey,
        success_url: returnUrl || 'https://kortix.com',
        cancel_url: returnUrl || 'https://kortix.com',
        commitment_type: commitmentType,
      };

      const response = await billingApi.createCheckoutSession(request);

      // Handle response status (matching frontend logic)
      if (response.checkout_url || response.url || response.fe_checkout_url) {
        const checkoutUrl = response.checkout_url || response.url || response.fe_checkout_url;
        if (checkoutUrl) {
          await Linking.openURL(checkoutUrl);
        }
      } else if (response.status === 'upgraded' || response.status === 'updated') {
        // Immediate upgrade
        handleSubscriptionUpdate();
      } else if (response.status === 'downgrade_scheduled' || response.status === 'scheduled') {
        // Downgrade scheduled
        handleSubscriptionUpdate();
      }

      setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
    } catch (error) {
      console.error('❌ Error processing subscription:', error);
      setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
    }
  };

  const tiersToShow = PRICING_TIERS.filter(
    (tier) => tier.hidden !== true && (!hideFree || tier.price !== '$0')
  );

  const creditsButtonScale = useSharedValue(1);
  const creditsLinkScale = useSharedValue(1);

  const creditsButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsButtonScale.value }],
  }));

  const creditsLinkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsLinkScale.value }],
  }));

  return (
    <View className={`flex-1 ${noPadding ? 'pb-0' : 'pb-12'}`}>
      <View className="w-full flex-col px-4">
        {showTitleAndTabs && (
          <AnimatedView 
            entering={FadeIn.duration(600)} 
            className="w-full items-center mb-6"
          >
            <Text className="text-3xl font-roobert-semibold text-center text-foreground leading-tight">
              {customTitle || 'Pick the plan that works for you.'}
            </Text>
          </AnimatedView>
        )}

        <AnimatedView 
          entering={FadeIn.duration(600).delay(100)} 
          className="w-full items-center mb-8"
        >
          <BillingPeriodToggle
            billingPeriod={billingPeriod}
            setBillingPeriod={setBillingPeriod}
          />
        </AnimatedView>

        <View className="w-full gap-4">
          {tiersToShow.map((tier, index) => {
            const displayPrice = getDisplayPrice(tier, billingPeriod);
            const isLoading = planLoadingStates[tier.id] || false;

            return (
              <PricingTierCard
                key={tier.id}
                tier={tier}
                displayPrice={displayPrice}
                billingPeriod={billingPeriod}
                currentSubscription={currentSubscription}
                isLoading={isLoading}
                isFetchingPlan={isFetchingPlan}
                onPlanSelect={handlePlanSelect}
                onSubscribe={handleSubscribe}
                onSubscriptionUpdate={handleSubscriptionUpdate}
                isAuthenticated={isAuthenticated}
                currentBillingPeriod={currentBillingPeriod}
                insideDialog={insideDialog}
                t={t}
                index={index}
              />
            );
          })}
        </View>

        {isAuthenticated &&
          currentSubscription?.credits?.can_purchase_credits && (
            <AnimatedView 
              entering={FadeIn.duration(600).delay(400)} 
              className="w-full mt-12 flex-col items-center gap-4"
            >
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
                className="h-12 border border-border rounded-2xl items-center justify-center flex-row gap-2 px-6 bg-card/50"
              >
                <Icon as={ShoppingCart} size={20} className="text-foreground" strokeWidth={2.5} />
                <Text className="text-base font-roobert-medium text-foreground">
                  Get Additional Credits
                </Text>
              </AnimatedPressable>

              <AnimatedPressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  Linking.openURL('https://app.agentpress.ai/credits-explained');
                }}
                onPressIn={() => {
                  creditsLinkScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
                }}
                onPressOut={() => {
                  creditsLinkScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                }}
                style={creditsLinkStyle}
                className="flex-row items-center gap-2 px-3 py-2"
              >
                <Icon as={Lightbulb} size={14} className="text-muted-foreground" strokeWidth={2} />
                <Text className="text-sm font-roobert text-muted-foreground">
                  Credits explained
                </Text>
              </AnimatedPressable>
            </AnimatedView>
          )}

        {(!isAuthenticated || !currentSubscription?.credits?.can_purchase_credits) && (
          <AnimatedView 
            entering={FadeIn.duration(600).delay(400)} 
            className="w-full mt-8 flex items-center"
          >
            <AnimatedPressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                Linking.openURL('https://app.agentpress.ai/credits-explained');
              }}
              onPressIn={() => {
                creditsLinkScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
              }}
              onPressOut={() => {
                creditsLinkScale.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
              style={creditsLinkStyle}
              className="flex-row items-center gap-2 px-3 py-2"
            >
              <Icon as={Lightbulb} size={14} className="text-muted-foreground" strokeWidth={2} />
              <Text className="text-sm font-roobert text-muted-foreground">
                Credits explained
              </Text>
            </AnimatedPressable>
          </AnimatedView>
        )}
      </View>

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
