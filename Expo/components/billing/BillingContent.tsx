/**
 * Billing Content Component
 * 
 * Reusable component for displaying billing/pricing options
 * Uses standardized components: TrialCard, PricingTierCard, BillingPeriodSelector
 */

import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { PRICING_TIERS, BillingPeriod, getPriceId, getDisplayPrice, startPlanCheckout, startTrialCheckout } from '@/lib/billing';
import * as Haptics from 'expo-haptics';
import { TrialCard } from './TrialCard';
import { PricingTierCard } from './PricingTierCard';
import { BillingPeriodSelector } from './BillingPeriodSelector';

interface BillingContentProps {
  canStartTrial: boolean;
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
  canStartTrial,
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
  const [selectedPlan, setSelectedPlan] = React.useState<string | null>(null);

  const handleStartTrial = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedPlan('trial');
    
    try {
      await startTrialCheckout(
        () => {
          // Success callback
          setSelectedPlan(null);
          onSuccess?.();
        },
        () => {
          // Cancel callback
          setSelectedPlan(null);
          onCancel?.();
        }
      );
    } catch (error) {
      console.error('❌ Error starting trial:', error);
      setSelectedPlan(null);
    }
  };

  const handleSelectPlan = async (tier: typeof PRICING_TIERS[0]) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedPlan(tier.name);

    const priceId = getPriceId(tier, billingPeriod);
    if (!priceId) {
      console.error('❌ No price ID found for tier:', tier.name, billingPeriod);
      setSelectedPlan(null);
      return;
    }

    try {
      await startPlanCheckout(
        priceId,
        billingPeriod,
        () => {
          // Success callback
          setSelectedPlan(null);
          onSuccess?.();
        },
        () => {
          // Cancel callback
          setSelectedPlan(null);
          onCancel?.();
        }
      );
    } catch (error) {
      console.error('❌ Error starting checkout:', error);
      setSelectedPlan(null);
    }
  };

  const tiersToShow = simplified ? PRICING_TIERS.slice(0, 2) : PRICING_TIERS;

  return (
    <View className="flex-1">
      {/* Title */}
      {showTitle && (
        <View className="mb-6">
          <Text className="text-2xl font-roobert-semibold text-foreground text-center mb-2">
            {titleText || (canStartTrial 
              ? t('billing.trial.title', 'Start Your Free Trial') 
              : t('billing.subscription.title', 'Choose Your Plan')
            )}
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

      {/* Free Trial Option */}
      {canStartTrial && (
        <TrialCard
          onPress={handleStartTrial}
          disabled={selectedPlan === 'trial'}
          t={t}
        />
      )}

      {/* Period Selector */}
      {!canStartTrial && (
        <BillingPeriodSelector
          selected={billingPeriod}
          onChange={setBillingPeriod}
          t={t}
        />
      )}

      {/* Pricing Tiers */}
      {!canStartTrial && (
        <View>
          {tiersToShow.map((tier) => {
            const displayPrice = getDisplayPrice(tier, billingPeriod);
            const isSelected = selectedPlan === tier.name;

            return (
              <PricingTierCard
                key={tier.name}
                tier={tier}
                displayPrice={displayPrice}
                billingPeriod={billingPeriod}
                isSelected={isSelected}
                onSelect={() => handleSelectPlan(tier)}
                disabled={isSelected}
                simplified={simplified}
                t={t}
              />
            );
          })}
        </View>
      )}

      {/* Footer Message */}
      <View className="mt-6 p-4 bg-muted/50 rounded-2xl">
        <Text className="text-xs text-center text-muted-foreground">
          {t('billing.footer', 'Cancel anytime. No questions asked.')}
        </Text>
      </View>
    </View>
  );
}

