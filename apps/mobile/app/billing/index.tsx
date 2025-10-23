/**
 * Billing Main Screen
 * 
 * Carousel-based pricing view matching Figma design
 */

import React, { useState } from 'react';
import { View, Pressable, Linking, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronLeft, ExternalLink } from 'lucide-react-native';
import { useBillingContext } from '@/contexts/BillingContext';
import { 
  CurrentPlanCard, 
  CreditsCard,
  PricingTierCard
} from '@/components/billing';
import { startPlanCheckout, getPriceId, PRICING_TIERS, getDisplayPrice, type PricingTier, type BillingPeriod } from '@/lib/billing';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';

export default function BillingIndexScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { subscriptionData, creditBalance, trialStatus, isLoading, refetchAll } = useBillingContext();
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('yearly_commitment');

  // Log raw API responses
  React.useEffect(() => {
    console.log('📊 RAW API RESPONSES:');
    console.log('  subscriptionData:', JSON.stringify(subscriptionData, null, 2));
    console.log('  creditBalance:', JSON.stringify(creditBalance, null, 2));
    console.log('  trialStatus:', JSON.stringify(trialStatus, null, 2));
  }, [subscriptionData, creditBalance, trialStatus]);

  // Billing data - minimal processing
  const hasActiveTrial = (trialStatus?.has_trial && trialStatus?.trial_status === 'active') || subscriptionData?.is_trial || subscriptionData?.status === 'trialing';
  const currentPlan = subscriptionData?.display_plan_name || subscriptionData?.tier?.display_name || subscriptionData?.tier?.name || 'Free';
  const isFreePlan = (subscriptionData?.tier?.name === 'free' || subscriptionData?.tier?.name === 'none') && !hasActiveTrial;
  const totalCredits = creditBalance?.balance || 0;
  const displayPlan = hasActiveTrial ? `Trial (${currentPlan})` : currentPlan;

  const handleSelectPlan = async (tier: PricingTier) => {
    try {
      setSelectedPlan(tier.id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Get the currently selected billing period
      const priceId = getPriceId(tier, billingPeriod);

      await startPlanCheckout(priceId, billingPeriod, () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        refetchAll();
        router.back();
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
    router.push('/billing/credits');
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

  // Function to check if a tier is currently active
  const isTierActive = (tier: PricingTier) => {
    if (!currentPriceId) return false;
    
    // Check both monthly and yearly price IDs for this tier
    const monthlyPriceId = getPriceId(tier, 'monthly');
    const yearlyPriceId = getPriceId(tier, 'yearly_commitment');
    
    return currentPriceId === monthlyPriceId || currentPriceId === yearlyPriceId;
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 pt-12 pb-4 border-b border-border">
        <View className="flex-row items-center gap-4">
          <Pressable onPress={() => router.back()} className="size-10 items-center justify-center">
            <Icon as={ChevronLeft} size={24} className="text-foreground" />
          </Pressable>
          <Text className="text-xl font-roobert-bold text-foreground">{t('billing.title')}</Text>
        </View>
      </View>

      {/* Billing Summary Section */}
      {!isLoading && (
        <View className="px-6 py-6 border-b border-border">
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
        </View>
      )}

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
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
          <View className="flex-row gap-[6px]">
            {/* Monthly Button */}
            <Pressable
              onPress={() => setBillingPeriod('monthly')}
              className={`h-[32px] px-[9px] py-[3px] rounded-[18px] items-center justify-center ${
                billingPeriod === 'monthly'
                  ? 'bg-[#121215] dark:bg-[#F8F8F8]'
                  : 'border-[0.75px] border-[rgba(0,0,0,0.12)] dark:border-[rgba(255,255,255,0.12)]'
              }`}
            >
              <Text
                className={`text-[12px] font-roobert-medium tracking-[-0.105px] leading-[16.8px] ${
                  billingPeriod === 'monthly'
                    ? 'text-[#F8F8F8] dark:text-[#121215]'
                    : 'text-[#121215] dark:text-[#F8F8F8] opacity-80'
                }`}
              >
                Monthly
              </Text>
            </Pressable>

            {/* Yearly Button with Badge */}
            <Pressable
              onPress={() => setBillingPeriod('yearly_commitment')}
              className={`h-[32px] pl-[9px] pr-[3px] py-[3px] rounded-[18px] flex-row items-center gap-[6px] ${
                billingPeriod === 'yearly_commitment'
                  ? 'bg-[#121215] dark:bg-[#F8F8F8]'
                  : 'border-[0.75px] border-[rgba(0,0,0,0.12)] dark:border-[rgba(255,255,255,0.12)]'
              }`}
            >
              <Text
                className={`text-[12px] font-roobert-medium tracking-[-0.105px] leading-[16.8px] ${
                  billingPeriod === 'yearly_commitment'
                    ? 'text-[#F8F8F8] dark:text-[#121215]'
                    : 'text-[#121215] dark:text-[#F8F8F8] opacity-80'
                }`}
              >
                Yearly
              </Text>
              {/* 15% off badge */}
              <View className="bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.05)] h-[26px] px-[10px] rounded-[174px] items-center justify-center">
                <Text className="text-[12px] font-roobert-medium text-[#121215] dark:text-[#F8F8F8] leading-[1.5]">
                  15% off
                </Text>
              </View>
            </Pressable>
          </View>
        </View>

        {/* Simple Vertical Pricing List */}
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
      </ScrollView>
    </View>
  );
}

