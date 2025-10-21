/**
 * Trial Activation Screen
 * 
 * Allows new users to start a 7-day free trial
 * Matches web's /activate-trial page
 */

import React, { useEffect } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle, CreditCard, Shield, Sparkles, ArrowRight } from 'lucide-react-native';
import { useBillingContext } from '@/contexts/BillingContext';
import { useCreateTrialCheckout, startTrialCheckout } from '@/lib/billing';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';

export default function TrialScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { subscriptionData, trialStatus, isLoading, refetchAll } = useBillingContext();
  const createTrialMutation = useCreateTrialCheckout();

  // Check if user should be here
  useEffect(() => {
    if (!isLoading && subscriptionData && trialStatus) {
      const hasActiveTrial = trialStatus.has_trial && trialStatus.trial_status === 'active';
      const hasUsedTrial =
        trialStatus.trial_status === 'used' ||
        trialStatus.trial_status === 'expired' ||
        trialStatus.trial_status === 'cancelled' ||
        trialStatus.trial_status === 'converted';
      const hasActiveSubscription =
        subscriptionData.tier && subscriptionData.tier.name !== 'none' && subscriptionData.tier.name !== 'free';

      if (hasActiveTrial || hasActiveSubscription) {
        router.replace('/home');
      } else if (hasUsedTrial) {
        router.replace('/billing/subscription');
      }
    }
  }, [subscriptionData, trialStatus, isLoading, router]);

  const handleStartTrial = async () => {
    try {
      console.log('🎁 Starting trial...');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      await startTrialCheckout(
        () => {
          // Success callback
          console.log('✅ Trial checkout completed');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          refetchAll();
          router.replace('/home');
        },
        () => {
          // Cancel callback
          console.log('❌ Trial checkout cancelled');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        }
      );
    } catch (error: any) {
      console.error('❌ Trial error:', error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow"
    >
      <View className="flex-1 px-6 py-12 justify-center">
        {/* Header */}
        <View className="items-center mb-8">
          <View className="size-20 rounded-full bg-primary/10 items-center justify-center mb-4">
            <Icon as={Sparkles} size={40} className="text-primary" />
          </View>

          <Text className="text-3xl font-roobert-bold text-foreground text-center mb-2">
            {t('billing.freeTrial')}
          </Text>

          <Text className="text-base font-roobert text-muted-foreground text-center">
            {t('billing.trialMessage')}
          </Text>
        </View>

        {/* Benefits */}
        <View className="bg-card border border-border rounded-2xl p-6 mb-6">
          <Text className="text-lg font-roobert-semibold text-foreground mb-4">
            {t('billing.trialBenefits')}
          </Text>

          <View className="gap-4">
            <View className="flex-row items-start gap-3">
              <View className="size-10 rounded-full bg-green-500/10 items-center justify-center mt-0.5">
                <Icon as={CheckCircle} size={20} className="text-green-600" />
              </View>
              <View className="flex-1">
                <Text className="text-base font-roobert-medium text-foreground">
                  {t('billing.trialCredit')}
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground">
                  {t('billing.trialFullAccess')}
                </Text>
              </View>
            </View>

            <View className="flex-row items-start gap-3">
              <View className="size-10 rounded-full bg-green-500/10 items-center justify-center mt-0.5">
                <Icon as={CheckCircle} size={20} className="text-green-600" />
              </View>
              <View className="flex-1">
                <Text className="text-base font-roobert-medium text-foreground">
                  {t('billing.trialDuration')}
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground">
                  {t('billing.trialCancelAnytime')}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Security message */}
        <View className="bg-primary/5 border border-primary/20 rounded-2xl p-4 mb-6">
          <View className="flex-row items-start gap-3">
            <Icon as={Shield} size={20} className="text-primary mt-0.5" />
            <View className="flex-1">
              <Text className="text-sm font-roobert-medium text-foreground mb-1">
                {t('billing.noChargeDuringTrial')}
              </Text>
              <Text className="text-xs font-roobert text-muted-foreground">
                {t('billing.trialMessage')}
              </Text>
            </View>
          </View>
        </View>

        {/* Start button */}
        <Pressable
          onPress={handleStartTrial}
          disabled={createTrialMutation.isPending}
          className="bg-primary h-14 rounded-2xl flex-row items-center justify-center gap-2 mb-4"
        >
          {createTrialMutation.isPending ? (
            <>
              <ActivityIndicator color="white" />
              <Text className="text-base font-roobert-semibold text-primary-foreground">
                {t('billing.starting')}
              </Text>
            </>
          ) : (
            <>
              <Icon as={CreditCard} size={18} className="text-primary-foreground" />
              <Text className="text-base font-roobert-semibold text-primary-foreground">
                {t('billing.startTrial')}
              </Text>
              <Icon as={ArrowRight} size={18} className="text-primary-foreground" />
            </>
          )}
        </Pressable>

        {/* Terms */}
        <Text className="text-xs font-roobert text-muted-foreground text-center">
          {t('billing.agreeToTerms')}
        </Text>
      </View>
    </ScrollView>
  );
}

