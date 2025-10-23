/**
 * Subscription Required Screen
 * 
 * Blocks access to the app when trial expired or no subscription
 * Shows pricing options to upgrade
 */

import React, { useEffect } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { LogOut, Clock, CreditCard } from 'lucide-react-native';
import { useBillingContext } from '@/contexts/BillingContext';
import { useAuthContext } from '@/contexts/AuthContext';
import { PRICING_TIERS, BillingPeriod, getPriceId, getDisplayPrice, startPlanCheckout } from '@/lib/billing';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';

export default function SubscriptionRequiredScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { subscriptionData, trialStatus, isLoading, refetchAll } = useBillingContext();
  const { signOut } = useAuthContext();
  const [billingPeriod, setBillingPeriod] = React.useState<BillingPeriod>('yearly_commitment');
  const [selectedPlan, setSelectedPlan] = React.useState<string | null>(null);

  // Check if user should be here
  useEffect(() => {
    if (!isLoading && subscriptionData && trialStatus) {
      const hasActiveTrial = trialStatus.has_trial && trialStatus.trial_status === 'active';
      const hasActiveSubscription =
        subscriptionData.tier && subscriptionData.tier.name !== 'none' && subscriptionData.tier.name !== 'free';

      if (hasActiveTrial || hasActiveSubscription) {
        router.replace('/home');
      }
    }
  }, [subscriptionData, trialStatus, isLoading, router]);

  const handleSelectPlan = async (tier: typeof PRICING_TIERS[0]) => {
    try {
      setSelectedPlan(tier.id);
      console.log('💳 Selecting plan:', tier.name);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const priceId = getPriceId(tier, billingPeriod);

      await startPlanCheckout(
        priceId,
        billingPeriod,
        () => {
          console.log('✅ Plan checkout completed');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          refetchAll();
          router.replace('/home');
        },
        () => {
          console.log('❌ Plan checkout cancelled');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setSelectedPlan(null);
        }
      );
    } catch (error) {
      console.error('❌ Plan selection error:', error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSelectedPlan(null);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/auth');
  };

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const isTrialExpired =
    trialStatus?.trial_status === 'expired' ||
    trialStatus?.trial_status === 'cancelled' ||
    trialStatus?.trial_status === 'used';

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="flex-grow">
      {/* Header */}
      <View className="px-6 pt-12 pb-6">
        <View className="flex-row items-center justify-between mb-4">
          <View className="flex-1" />
          <Pressable onPress={handleSignOut} className="flex-row items-center gap-2 px-3 py-2 border border-border rounded-xl">
            <Icon as={LogOut} size={16} className="text-muted-foreground" />
            <Text className="text-sm font-roobert-medium text-muted-foreground">{t('auth.signOut')}</Text>
          </Pressable>
        </View>

        <View className="items-center">
          <View className="size-16 rounded-full bg-destructive/10 items-center justify-center mb-4">
            <Icon as={Clock} size={32} className="text-destructive" />
          </View>

          <Text className="text-2xl font-roobert-bold text-foreground text-center mb-2">
            {isTrialExpired ? t('billing.trialEnded') : t('billing.subscriptionRequired')}
          </Text>

          <Text className="text-base font-roobert text-muted-foreground text-center">
            {isTrialExpired
              ? 'Your 7-day free trial has ended. Choose a plan to continue.'
              : 'A subscription is required to use the app. Choose the plan that works best for you.'}
          </Text>
        </View>
      </View>

      {/* Billing Period Toggle */}
      <View className="px-6 mb-4">
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
          const isSelecting = selectedPlan === tier.id;

          return (
            <Pressable
              key={tier.id}
              onPress={() => handleSelectPlan(tier)}
              disabled={isSelecting}
              className={`bg-card border-2 rounded-2xl p-6 ${
                tier.isPopular ? 'border-primary' : 'border-border'
              }`}
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

              <View className="bg-primary h-12 rounded-xl items-center justify-center">
                {isSelecting ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-base font-roobert-semibold text-primary-foreground">
                    {tier.buttonText}
                  </Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

