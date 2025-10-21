/**
 * Credits Purchase Screen
 * 
 * Allows users to purchase additional credits
 */

import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronLeft, Coins, Infinity } from 'lucide-react-native';
import { useBillingContext } from '@/contexts/BillingContext';
import { startCreditPurchase } from '@/lib/billing';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';

const CREDIT_PACKAGES = [10, 25, 50, 100, 200, 500];

export default function CreditsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { creditBalance, refetchBalance } = useBillingContext();
  const [purchasing, setPurchasing] = React.useState<number | null>(null);

  const handlePurchase = async (amount: number) => {
    try {
      setPurchasing(amount);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      await startCreditPurchase(amount, () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        refetchBalance();
        router.back();
      }, () => {
        setPurchasing(null);
      });
    } catch (error) {
      console.error('❌ Purchase error:', error);
      setPurchasing(null);
    }
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 pt-12 pb-4 border-b border-border">
        <View className="flex-row items-center gap-4 mb-4">
          <Pressable onPress={() => router.back()} className="size-10 items-center justify-center">
            <Icon as={ChevronLeft} size={24} className="text-foreground" />
          </Pressable>
          <Text className="text-xl font-roobert-bold text-foreground">{t('billing.purchaseCredits')}</Text>
        </View>
      </View>

      <ScrollView className="flex-1">
        {/* Current Balance */}
        {creditBalance && (
          <View className="mx-6 my-6 p-6 bg-card border border-border rounded-2xl">
            <View className="flex-row items-center justify-between">
              <View>
                <Text className="text-sm font-roobert text-muted-foreground mb-1">{t('billing.balance')}</Text>
                <Text className="text-3xl font-roobert-bold text-foreground">
                  ${creditBalance.balance.toFixed(2)}
                </Text>
              </View>
              <Icon as={Coins} size={32} className="text-primary" />
            </View>
          </View>
        )}

        {/* Info Banner */}
        <View className="mx-6 mb-6 p-4 bg-green-500/10 border border-green-500/20 rounded-2xl">
          <View className="flex-row items-start gap-3">
            <Icon as={Infinity} size={20} className="text-green-600 mt-0.5" />
            <Text className="flex-1 text-sm font-roobert text-green-700">
              {t('billing.neverExpires')} - Purchased credits are used after your monthly plan credits are exhausted.
            </Text>
          </View>
        </View>

        {/* Credit Packages */}
        <View className="px-6 pb-6">
          <View className="grid grid-cols-2 gap-4">
            {CREDIT_PACKAGES.map((amount) => {
              const isPurchasing = purchasing === amount;
              return (
                <Pressable
                  key={amount}
                  onPress={() => handlePurchase(amount)}
                  disabled={isPurchasing}
                  className="bg-card border border-border rounded-2xl p-6 items-center"
                >
                  <Text className="text-3xl font-roobert-bold text-foreground mb-2">
                    ${amount}
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground mb-4">
                    {amount} credits
                  </Text>
                  <View className="bg-primary h-10 w-full rounded-xl items-center justify-center">
                    {isPurchasing ? (
                      <ActivityIndicator color="white" size="small" />
                    ) : (
                      <Text className="text-sm font-roobert-semibold text-primary-foreground">
                        {t('billing.selectPlan')}
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

