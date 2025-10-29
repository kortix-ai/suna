/**
 * Credits Purchase Page Component
 * 
 * Allows users to purchase additional credits
 */

import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Coins, Infinity, Clock } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { useBillingContext } from '@/contexts/BillingContext';
import { useLanguage } from '@/contexts';
import { CreditPackages } from '@/components/billing';
import { startCreditPurchase } from '@/lib/billing';
import * as Haptics from 'expo-haptics';

interface CreditsPurchasePageProps {
  visible: boolean;
  onClose: () => void;
}

export function CreditsPurchasePage({ visible, onClose }: CreditsPurchasePageProps) {
  const { t } = useLanguage();
  const { creditBalance, refetchBalance } = useBillingContext();
  const [purchasing, setPurchasing] = React.useState<number | null>(null);

  const handleClose = () => {
    console.log('🎯 Credits purchase page closed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  const handlePurchase = async (amount: number) => {
    try {
      setPurchasing(amount);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      await startCreditPurchase(amount, () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        refetchBalance();
        handleClose();
      }, () => {
        setPurchasing(null);
      });
    } catch (error) {
      console.error('❌ Purchase error:', error);
      setPurchasing(null);
    }
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
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          {/* Header */}
          <SettingsHeader
            title={t('billing.purchaseCredits') || 'Purchase Credits'}
            onClose={handleClose}
          />

          {/* Current Balance */}
          {creditBalance && (
            <View className="mx-6 mb-6 p-6 bg-card border border-border rounded-2xl">
              <View className="flex-row items-center justify-between mb-4">
                <View>
                  <Text className="text-sm font-roobert text-muted-foreground mb-1">
                    {t('billing.balance') || 'Current Balance'}
                  </Text>
                  <Text className="text-3xl font-roobert-bold text-foreground">
                    ${creditBalance.balance.toFixed(2)}
                  </Text>
                </View>
                <Icon as={Coins} size={32} className="text-primary" />
              </View>
              
              {/* Breakdown */}
              {(creditBalance.expiring_credits > 0 || creditBalance.non_expiring_credits > 0) && (
                <View className="pt-4 border-t border-border space-y-2">
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-2">
                      <Icon as={Clock} size={14} className="text-muted-foreground" />
                      <Text className="text-sm font-roobert text-muted-foreground">
                        Plan credits
                      </Text>
                    </View>
                    <Text className="text-sm font-roobert-semibold text-foreground">
                      ${creditBalance.expiring_credits.toFixed(2)}
                    </Text>
                  </View>
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-2">
                      <Icon as={Infinity} size={14} className="text-green-600" />
                      <Text className="text-sm font-roobert text-muted-foreground">
                        Purchased credits
                      </Text>
                    </View>
                    <Text className="text-sm font-roobert-semibold text-foreground">
                      ${creditBalance.non_expiring_credits.toFixed(2)}
                    </Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {/* Info Banner */}
          <View className="mx-6 mb-6 p-4 bg-primary/10 border border-primary/20 rounded-2xl">
            <View className="flex-row items-start gap-3">
              <Icon as={Infinity} size={20} className="text-primary mt-0.5" />
              <Text className="flex-1 text-sm font-roobert text-foreground/80">
                {t('billing.neverExpires') || 'Purchased credits never expire'} - They're used after your monthly plan credits are exhausted.
              </Text>
            </View>
          </View>

          {/* Credit Packages */}
          <View className="px-6 pb-6">
            <CreditPackages
              onPurchase={handlePurchase}
              purchasing={purchasing}
              t={t}
            />
          </View>
          
          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

