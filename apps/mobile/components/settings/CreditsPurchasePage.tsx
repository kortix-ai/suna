import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Infinity, Clock, Sparkles, Info, Wallet } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { useBillingContext } from '@/contexts/BillingContext';
import { useLanguage } from '@/contexts';
import { CreditPackages } from '@/components/billing';
import { startUnifiedCreditPurchase, shouldUseRevenueCat, invalidateCreditsAfterPurchase } from '@/lib/billing';
import * as Haptics from 'expo-haptics';
import { formatCredits } from '@/lib/utils/credit-formatter';
import { useQueryClient } from '@tanstack/react-query';

interface CreditsPurchasePageProps {
  visible: boolean;
  onClose: () => void;
}

export function CreditsPurchasePage({ visible, onClose }: CreditsPurchasePageProps) {
  const { t } = useLanguage();
  const { creditBalance, refetchBalance } = useBillingContext();
  const [purchasing, setPurchasing] = React.useState<number | null>(null);
  const queryClient = useQueryClient();

  const handleClose = () => {
    console.log('🎯 Credits purchase page closed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  const handlePurchase = async (amount: number, packageId?: string) => {
    try {
      setPurchasing(amount);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      await startUnifiedCreditPurchase(amount, packageId, () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        invalidateCreditsAfterPurchase(queryClient);
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

  const expiringCredits = creditBalance?.expiring_credits || 0;
  const nonExpiringCredits = creditBalance?.non_expiring_credits || 0;
  const totalCredits = creditBalance?.balance || 0;

  return (
    <View className="absolute inset-0 z-50 bg-background">
      <ScrollView 
        className="flex-1" 
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        <SettingsHeader
          title={t('billing.buyCredits')}
          onClose={handleClose}
        />
        
        <View className="px-6">
          <View className="mb-4 items-center pt-4">
            <View className="flex-row items-center gap-3">
              <View className="h-10 -mt-2 w-10 items-center justify-center rounded-full bg-green-500">
                <Icon as={Wallet} size={20} className="text-white" />
              </View>
              <Text className="text-5xl font-roobert-semibold text-foreground tracking-tight">
                {formatCredits(totalCredits)}
              </Text>
            </View>
            <Text className="text-sm font-roobert text-muted-foreground">
              {t('billing.availableCredits')}
            </Text>
          </View>

          <View className="mb-6">
            {(expiringCredits > 0 || nonExpiringCredits > 0) && (
              <View className="flex-row gap-3 pt-5">
                <View className="flex-1 bg-primary/5 rounded-2xl p-4">
                  <View className="flex-row items-center gap-2 mb-2">
                    <Icon as={Clock} size={14} className="text-muted-foreground" strokeWidth={2} />
                    <Text className="text-xs font-roobert-medium text-muted-foreground">
                      {t('billing.monthly')}
                    </Text>
                  </View>
                  <Text className="text-2xl font-roobert-semibold text-foreground tracking-tight">
                    {formatCredits(expiringCredits)}
                  </Text>
                </View>
                <View className="flex-1 bg-primary/5 rounded-2xl p-4">
                  <View className="flex-row items-center gap-2 mb-2">
                    <Icon as={Infinity} size={14} className="text-primary" strokeWidth={2} />
                    <Text className="text-xs font-roobert-medium text-primary">
                      {t('billing.extra')}
                    </Text>
                  </View>
                  <Text className="text-2xl font-roobert-semibold text-foreground tracking-tight">
                    {formatCredits(nonExpiringCredits)}
                  </Text>
                </View>
              </View>
            )}
          </View>

          <View className="mb-4">
            <Text className="text-base font-roobert-semibold text-foreground mb-1 tracking-tight">
              {t('billing.creditPackages')}
            </Text>
            <Text className="text-xs font-roobert text-muted-foreground">
              {t('billing.choosePackageBoost')}
            </Text>
          </View>

          <CreditPackages
            onPurchase={handlePurchase}
            purchasing={purchasing}
            t={t}
            useRevenueCat={shouldUseRevenueCat()}
            offeringId="topups"
          />
        </View>
      </ScrollView>
    </View>
  );
}

