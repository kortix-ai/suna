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

  return (
    <View className={`flex-1 ${noPadding ? 'pb-0' : 'pb-12'}`}>
      <View className="w-full flex-col px-4">
        {showTitleAndTabs && (
          <View className="w-full items-center mb-6">
            <Text className="text-3xl font-roobert-semibold text-center text-foreground">
              {customTitle || 'Pick the plan that works for you.'}
            </Text>
          </View>
        )}

        <View className="w-full items-center mb-8">
          <BillingPeriodToggle
            billingPeriod={billingPeriod}
            setBillingPeriod={setBillingPeriod}
          />
        </View>

        <View className="w-full gap-4">
          {tiersToShow.map((tier) => {
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
              />
            );
          })}
        </View>

        {/* Get Additional Credits Button - Only visible if tier allows credit purchases */}
        {isAuthenticated &&
          currentSubscription?.credits?.can_purchase_credits && (
            <View className="w-full mt-12 flex-col items-center gap-4">
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowCreditPurchaseModal(true);
                }}
                className="h-12 border border-border rounded-xl items-center justify-center flex-row gap-2 px-6"
              >
                <Icon as={ShoppingCart} size={20} className="text-foreground" strokeWidth={2} />
                <Text className="text-base font-roobert-medium text-foreground">
                  Get Additional Credits
                </Text>
              </Pressable>
              {/* Credits Explained Link */}
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  Linking.openURL('https://app.agentpress.ai/credits-explained');
                }}
                className="flex-row items-center gap-2"
              >
                <Icon as={Lightbulb} size={14} className="text-muted-foreground" strokeWidth={2} />
                <Text className="text-sm font-roobert text-muted-foreground">
                  Credits explained
                </Text>
              </Pressable>
            </View>
          )}

        {/* Credits Explained Link - Show when not authenticated or when credits purchase is not available */}
        {(!isAuthenticated || !currentSubscription?.credits?.can_purchase_credits) && (
          <View className="w-full mt-8 flex items-center">
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                Linking.openURL('https://app.agentpress.ai/credits-explained');
              }}
              className="flex-row items-center gap-2"
            >
              <Icon as={Lightbulb} size={14} className="text-muted-foreground" strokeWidth={2} />
              <Text className="text-sm font-roobert text-muted-foreground">
                Credits explained
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Credit Purchase Modal */}
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
