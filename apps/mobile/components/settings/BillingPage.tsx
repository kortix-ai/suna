/**
 * Billing Page Component
 * 
 * Displays subscription plans, credits, and billing management
 */

import React, { useState } from 'react';
import { View, Pressable, Linking, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ExternalLink } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { useBillingContext } from '@/contexts/BillingContext';
import { useLanguage } from '@/contexts';
import { 
  CurrentPlanCard, 
  CreditsCard,
  PricingTierCard
} from '@/components/billing';
import { startPlanCheckout, getPriceId, PRICING_TIERS, getDisplayPrice, type PricingTier, type BillingPeriod } from '@/lib/billing';
import * as Haptics from 'expo-haptics';

interface BillingPageProps {
  visible: boolean;
  onClose: () => void;
  onOpenCredits: () => void;
}

export function BillingPage({ visible, onClose, onOpenCredits }: BillingPageProps) {
  const { t } = useLanguage();
  const { subscriptionData, creditBalance, trialStatus, isLoading, refetchAll } = useBillingContext();
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('yearly_commitment');

  const handleClose = () => {
    console.log('🎯 Billing page closed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  // Billing data - minimal processing
  const hasActiveTrial = (trialStatus?.has_trial && trialStatus?.trial_status === 'active') || subscriptionData?.is_trial || subscriptionData?.status === 'trialing';
  const currentPlan = subscriptionData?.display_plan_name || subscriptionData?.tier?.display_name || subscriptionData?.tier?.name || 'Free';
  const isFreePlan = (subscriptionData?.tier?.name === 'free' || subscriptionData?.tier?.name === 'none') && !hasActiveTrial;
  const totalCredits = creditBalance?.balance || 0;
  const displayPlan = hasActiveTrial ? `Trial (${currentPlan})` : currentPlan;

  const handleSelectPlan = async (tier: PricingTier) => {
    try {
      setSelectedPlan(tier.id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const priceId = getPriceId(tier, billingPeriod);

      await startPlanCheckout(priceId, billingPeriod, () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        refetchAll();
        handleClose();
      }, () => {
        setSelectedPlan(null);
      });
    } catch (error) {
      console.error('❌ Error:', error);
      setSelectedPlan(null);
    }
  };

  const handlePurchaseCredits = () => {
    console.log('🎯 Purchase Credits pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpenCredits();
  };

  const handleManageBillingWeb = async () => {
    console.log('🎯 Manage Billing (Web) pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = 'https://app.agentpress.ai/subscription';
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
    } else {
      console.error('❌ Unable to open billing portal');
    }
  };

  const currentPriceId = subscriptionData?.price_id;

  const isTierActive = (tier: PricingTier) => {
    if (!currentPriceId) return false;
    const monthlyPriceId = getPriceId(tier, 'monthly');
    const yearlyPriceId = getPriceId(tier, 'yearly_commitment');
    return currentPriceId === monthlyPriceId || currentPriceId === yearlyPriceId;
  };

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      {/* Backdrop */}
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      {/* Page */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={false}
        >
          {/* Header */}
          <SettingsHeader
            title={t('billing.title')}
            onClose={handleClose}
          />

          {/* Billing Summary Section */}
          <View className="px-6 py-6 border-b border-border">
            {!isLoading && (
              <>
                <CurrentPlanCard
                  displayPlan={displayPlan}
                  hasActiveTrial={hasActiveTrial}
                  isFreePlan={isFreePlan}
                  t={t}
                />
                
                <CreditsCard
                  creditBalance={creditBalance}
                  totalCredits={totalCredits}
                  onPress={handlePurchaseCredits}
                  t={t}
                />
                
                {/* Manage Billing Web Button */}
                <Pressable
                  onPress={handleManageBillingWeb}
                  className="flex-row items-center justify-center gap-2 py-2"
                >
                  <Text className="text-sm font-roobert text-primary">
                    {t('billing.manageBilling')}
                  </Text>
                  <Icon as={ExternalLink} size={14} className="text-primary" strokeWidth={2} />
                </Pressable>
              </>
            )}
          </View>

          {/* Pricing Section Header */}
          <View className="px-6 pt-6 pb-2">
            <Text className="text-xl font-roobert-bold text-foreground">
              {t('billing.choosePlan')}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground mt-1">
              Select the plan that works best for you
            </Text>
          </View>

          {/* Monthly/Yearly Switcher */}
          <View className="items-center mb-6">
            <View className="flex-row gap-2 px-6">
              <Pressable
                onPress={() => setBillingPeriod('monthly')}
                className={`flex-1 h-10 rounded-xl items-center justify-center ${
                  billingPeriod === 'monthly'
                    ? 'bg-primary'
                    : 'bg-secondary border-2 border-border'
                }`}
              >
                <Text
                  className={`text-sm font-roobert-medium ${
                    billingPeriod === 'monthly'
                      ? 'text-primary-foreground'
                      : 'text-foreground'
                  }`}
                >
                  Monthly
                </Text>
              </Pressable>

              <Pressable
                onPress={() => setBillingPeriod('yearly_commitment')}
                className={`flex-1 h-10 rounded-xl items-center justify-center ${
                  billingPeriod === 'yearly_commitment'
                    ? 'bg-primary'
                    : 'bg-secondary border-2 border-border'
                }`}
              >
                <View className="items-center">
                  <Text
                    className={`text-sm font-roobert-medium ${
                      billingPeriod === 'yearly_commitment'
                        ? 'text-primary-foreground'
                        : 'text-foreground'
                    }`}
                  >
                    Yearly
                  </Text>
                  <Text className="text-xs text-primary">
                    Save 15%
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>

          {/* Pricing Tiers */}
          <View className="px-6 pb-6">
            {PRICING_TIERS.map((tier) => {
              const displayPrice = getDisplayPrice(tier, billingPeriod);
              const isActive = isTierActive(tier);
              return (
                <PricingTierCard
                  key={tier.id}
                  tier={tier}
                  displayPrice={displayPrice}
                  billingPeriod={billingPeriod}
                  isSelected={isActive}
                  onSelect={() => handleSelectPlan(tier)}
                  disabled={isActive}
                  simplified={false}
                  t={(key: string, defaultValue?: string) => t(key, defaultValue || '')}
                />
              );
            })}
          </View>
          
          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

