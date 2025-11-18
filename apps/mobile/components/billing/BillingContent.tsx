/**
 * Billing Content Component
 * 
 * Reusable component for displaying billing/pricing options
 * Uses standardized components: PricingTierCard, BillingPeriodSelector
 */

import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { PRICING_TIERS, BillingPeriod, getDisplayPrice } from '@/lib/billing';
import { startUnifiedPlanCheckout } from '@/lib/billing/unified-checkout';
import * as Haptics from 'expo-haptics';
import { PricingTierCard } from './PricingTierCard';
import { BillingPeriodSelector } from './BillingPeriodSelector';
import { useState } from 'react';

interface BillingContentProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  showTitle?: boolean;
  titleText?: string;
  subtitleText?: string;
  showStatusMessage?: boolean;
  statusMessage?: string;
  simplified?: boolean; // Show fewer tiers for onboarding
  t: (key: string, defaultValue?: string) => string;
}

export function BillingContent({
  onSuccess,
  onCancel,
  showTitle = true,
  titleText,
  subtitleText,
  showStatusMessage = false,
  statusMessage,
  simplified = false,
  t,
}: BillingContentProps) {
  const [billingPeriod, setBillingPeriod] = React.useState<BillingPeriod>('yearly_commitment');
  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});

  const handleSubscribe = async (tierKey: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: true }));

    try {
      await startUnifiedPlanCheckout(
        tierKey,
        billingPeriod,
        () => {
          setPlanLoadingStates({});
          onSuccess?.();
        },
        () => {
          setPlanLoadingStates({});
          onCancel?.();
        }
      );
    } catch (error) {
      console.error('❌ Error starting checkout:', error);
      setPlanLoadingStates({});
    }
  };

  const tiersToShow = simplified ? PRICING_TIERS.slice(0, 2) : PRICING_TIERS;

  return (
    <View className="flex-1">
      {/* Title */}
      {showTitle && (
        <View className="mb-6">
          <Text className="text-2xl font-roobert-semibold text-foreground text-center mb-2">
            {titleText || t('billing.subscription.title', 'Choose Your Plan')}
          </Text>
          {subtitleText && (
            <Text className="text-[15px] text-muted-foreground text-center">
              {subtitleText}
            </Text>
          )}
        </View>
      )}

      {/* Status Message */}
      {showStatusMessage && statusMessage && (
        <View className="mb-6 p-4 bg-destructive/10 rounded-2xl border border-destructive/20">
          <Text className="text-destructive font-medium text-center">
            {statusMessage}
          </Text>
        </View>
      )}

      {/* Period Selector */}
      <BillingPeriodSelector
        selected={billingPeriod}
        onChange={setBillingPeriod}
        t={t}
      />

      {/* Pricing Tiers */}
      <View>
          {tiersToShow.map((tier) => {
            const displayPrice = getDisplayPrice(tier, billingPeriod);
            const isLoading = planLoadingStates[tier.id] || false;

            return (
              <PricingTierCard
                key={tier.id}
                tier={tier}
                displayPrice={displayPrice}
                billingPeriod={billingPeriod}
                currentSubscription={null}
                isLoading={isLoading}
                isFetchingPlan={false}
                onPlanSelect={(planId) => setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }))}
                onSubscribe={handleSubscribe}
                isAuthenticated={false}
                currentBillingPeriod={null}
                t={t}
              />
            );
          })}
        </View>

      {/* Footer Message */}
      <View className="mt-6 p-4 bg-muted/50 rounded-2xl">
        <Text className="text-xs text-center text-muted-foreground">
          {t('billing.footer', 'Cancel anytime. No questions asked.')}
        </Text>
      </View>
    </View>
  );
}

