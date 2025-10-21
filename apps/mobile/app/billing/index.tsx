/**
 * Billing Main Screen
 * 
 * Pricing and tier selection for existing users
 */

import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Linking, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronLeft, CreditCard, Coins, Clock, Infinity as InfinityIcon, ExternalLink, ChevronRight } from 'lucide-react-native';
import { useBillingContext } from '@/contexts/BillingContext';
import { PRICING_TIERS, BillingPeriod, getPriceId, getDisplayPrice, startPlanCheckout } from '@/lib/billing';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';

export default function BillingIndexScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { subscriptionData, creditBalance, trialStatus, isLoading, refetchAll } = useBillingContext();
  const [billingPeriod, setBillingPeriod] = React.useState<BillingPeriod>('yearly_commitment');
  const [selectedPlan, setSelectedPlan] = React.useState<string | null>(null);

  // Debug logging
  React.useEffect(() => {
    console.log('📊 Billing Screen Data:', {
      subscriptionData,
      creditBalance,
      trialStatus,
      isLoading,
    });
  }, [subscriptionData, creditBalance, trialStatus, isLoading]);

  // Billing data
  const hasActiveTrial = (trialStatus?.has_trial && trialStatus?.trial_status === 'active') || subscriptionData?.is_trial || subscriptionData?.status === 'trialing';
  const currentPlan = subscriptionData?.display_plan_name || subscriptionData?.tier?.display_name || subscriptionData?.tier?.name || 'Free';
  const isFreePlan = (subscriptionData?.tier?.name === 'free' || subscriptionData?.tier?.name === 'none') && !hasActiveTrial;
  
  // Calculate actual available credits (granted - used)
  const grantedCredits = creditBalance?.lifetime_granted || subscriptionData?.credits?.lifetime_granted || 0;
  const usedCredits = creditBalance?.lifetime_used || subscriptionData?.credits?.lifetime_used || subscriptionData?.current_usage || 0;
  const currentCredits = Math.max(0, grantedCredits - usedCredits);
  
  const hasUnlimitedCredits = subscriptionData?.tier?.credits === -1;
  
  // Display plan name - show trial info if in trial, otherwise show plan name
  const displayPlan = hasActiveTrial 
    ? `Trial (${currentPlan})` 
    : currentPlan;

  console.log('💳 Billing computed values:', {
    currentPlan,
    displayPlan,
    isFreePlan,
    hasActiveTrial,
    grantedCredits,
    usedCredits,
    currentCredits,
    hasUnlimitedCredits,
    trialTier: trialStatus?.tier,
    subscriptionStatus: subscriptionData?.status,
    isTrial: subscriptionData?.is_trial,
  });

  const handleSelectPlan = async (tier: typeof PRICING_TIERS[0]) => {
    try {
      setSelectedPlan(tier.id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

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
      Alert.alert(t('common.error'), 'Unable to open billing portal');
    }
  };

  const currentPriceId = subscriptionData?.price_id;

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

      <ScrollView className="flex-1">
        {/* Billing Summary Section */}
        {!isLoading && (
          <View className="px-6 py-6 border-b border-border">
            {/* Current Plan Card */}
            <View className="bg-card border-[1.5px] border-border rounded-2xl p-4 mb-3">
              <View className="flex-row items-center justify-between mb-3">
                <View className="flex-row items-center gap-2">
                  <Icon as={CreditCard} size={18} className="text-primary" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-muted-foreground">
                    {t('billing.currentPlan')}
                  </Text>
                </View>
              </View>
              
              <View className="flex-row items-center justify-between">
                <View>
                  <Text className="text-lg font-roobert-semibold text-foreground capitalize">
                    {displayPlan}
                  </Text>
                  {hasActiveTrial && (
                    <View className="flex-row items-center gap-1.5 mt-1">
                      <Icon as={Clock} size={14} className="text-primary" strokeWidth={2} />
                      <Text className="text-xs font-roobert-medium text-primary">
                        {t('billing.trialActive')}
                      </Text>
                    </View>
                  )}
                </View>
                
                {isFreePlan && !hasActiveTrial && (
                  <View className="bg-primary px-3 py-1.5 rounded-full">
                    <Text className="text-xs font-roobert-medium text-primary-foreground">
                      {t('billing.upgradePlan')}
                    </Text>
                  </View>
                )}
              </View>
            </View>
            
            {/* Credits Card */}
            <Pressable
              onPress={handlePurchaseCredits}
              className="bg-card border-[1.5px] border-border rounded-2xl p-4 mb-3"
            >
              <View className="flex-row items-center justify-between mb-3">
                <View className="flex-row items-center gap-2">
                  <Icon as={Coins} size={18} className="text-primary" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-muted-foreground">
                    {t('billing.credits')}
                  </Text>
                </View>
                <Icon as={ChevronRight} size={16} className="text-foreground/40" strokeWidth={2} />
              </View>
              
              <View className="flex-row items-center justify-between">
                <View>
                  {hasUnlimitedCredits ? (
                    <View className="flex-row items-center gap-2">
                      <Icon as={InfinityIcon} size={20} className="text-foreground" strokeWidth={2} />
                      <Text className="text-lg font-roobert-semibold text-foreground">
                        {t('billing.unlimitedCredits')}
                      </Text>
                    </View>
                  ) : (
                    <Text className="text-lg font-roobert-semibold text-foreground">
                      ${currentCredits.toFixed(2)}
                    </Text>
                  )}
                </View>
                
                {!hasUnlimitedCredits && (
                  <View className="bg-primary/10 px-3 py-1.5 rounded-full border border-primary/30">
                    <Text className="text-xs font-roobert-medium text-primary">
                      {t('billing.buyCredits')}
                    </Text>
                  </View>
                )}
              </View>
              
              {/* Low credit warning */}
              {!hasUnlimitedCredits && currentCredits < 1 && currentCredits >= 0 && (
                <View className="mt-3 pt-3 border-t border-border">
                  <Text className="text-xs font-roobert text-destructive">
                    {t('billing.lowCreditsWarning')}
                  </Text>
                </View>
              )}
            </Pressable>
            
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

        {/* Pricing Section Header */}
        <View className="px-6 pt-6 pb-2">
          <Text className="text-xl font-roobert-bold text-foreground">
            {t('billing.choosePlan')}
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground mt-1">
            Select the plan that works best for you
          </Text>
        </View>

        {/* Billing Period Toggle */}
        <View className="px-6 py-4">
          <View className="bg-muted rounded-full p-1 flex-row">
            <Pressable
              onPress={() => setBillingPeriod('monthly')}
              className={`flex-1 h-10 rounded-full items-center justify-center ${
                billingPeriod === 'monthly' ? 'bg-background' : ''
              }`}
            >
              <Text className={`text-sm font-roobert-medium ${
                billingPeriod === 'monthly' ? 'text-foreground' : 'text-muted-foreground'
              }`}>
                {t('billing.monthly')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setBillingPeriod('yearly_commitment')}
              className={`flex-1 h-10 rounded-full items-center justify-center ${
                billingPeriod === 'yearly_commitment' ? 'bg-background' : ''
              }`}
            >
              <View className="flex-row items-center gap-2">
                <Text className={`text-sm font-roobert-medium ${
                  billingPeriod === 'yearly_commitment' ? 'text-foreground' : 'text-muted-foreground'
                }`}>
                  {t('billing.yearly')}
                </Text>
                <View className="bg-green-500 px-2 py-0.5 rounded-full">
                  <Text className="text-[10px] font-roobert-bold text-white">{t('billing.yearlyDiscount')}</Text>
                </View>
              </View>
            </Pressable>
          </View>
        </View>

        {/* Pricing Cards */}
        <View className="px-6 pb-6 gap-4">
          {PRICING_TIERS.map((tier) => {
            const displayPrice = getDisplayPrice(tier, billingPeriod);
            const priceId = getPriceId(tier, billingPeriod);
            const isCurrentPlan = currentPriceId === priceId;
            const isSelecting = selectedPlan === tier.id;

            return (
              <Pressable
                key={tier.id}
                onPress={() => !isCurrentPlan && handleSelectPlan(tier)}
                disabled={isCurrentPlan || isSelecting}
                className={`bg-card border-2 rounded-2xl p-6 ${
                  tier.isPopular ? 'border-primary' : 'border-border'
                } ${isCurrentPlan ? 'opacity-60' : ''}`}
              >
                {tier.isPopular && (
                  <View className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary px-3 py-1 rounded-full">
                    <Text className="text-xs font-roobert-bold text-primary-foreground">Popular</Text>
                  </View>
                )}

                <View className="flex-row items-start justify-between mb-4">
                  <View>
                    <Text className="text-lg font-roobert-bold text-foreground mb-1">{tier.displayName}</Text>
                    <View className="flex-row items-baseline gap-1">
                      <Text className="text-3xl font-roobert-bold text-foreground">{displayPrice}</Text>
                      <Text className="text-sm font-roobert text-muted-foreground">{t('billing.monthlyPrice')}</Text>
                    </View>
                  </View>
                  <Icon as={CreditCard} size={24} className="text-primary" />
                </View>

                <View className="gap-2 mb-4">
                  {tier.features.map((feature, index) => (
                    <Text key={index} className="text-sm font-roobert text-muted-foreground">
                      • {feature}
                    </Text>
                  ))}
                </View>

                <View className={`h-12 rounded-xl items-center justify-center ${
                  isCurrentPlan ? 'bg-muted' : 'bg-primary'
                }`}>
                  {isSelecting ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text className={`text-base font-roobert-semibold ${
                      isCurrentPlan ? 'text-muted-foreground' : 'text-primary-foreground'
                    }`}>
                      {isCurrentPlan ? t('billing.currentActive') : tier.buttonText}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

