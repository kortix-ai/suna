/**
 * Credit Packages Component
 * 
 * Displays available credit packages for purchase
 */

import React from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';

const CREDIT_PACKAGES = [10, 25, 50, 100, 200, 500];

interface CreditPackagesProps {
  onPurchase: (amount: number) => void;
  purchasing: number | null;
  t: (key: string) => string;
}

export function CreditPackages({ onPurchase, purchasing, t }: CreditPackagesProps) {
  return (
    <View className="grid grid-cols-2 gap-4">
      {CREDIT_PACKAGES.map((amount) => {
        const isPurchasing = purchasing === amount;
        return (
          <Pressable
            key={amount}
            onPress={() => onPurchase(amount)}
            disabled={isPurchasing}
            className="bg-card border border-border rounded-2xl p-6 items-center"
          >
            <Text className="text-3xl font-roobert-bold text-foreground mb-2">
              ${amount}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground mb-4">
              {amount} {t('billing.credits')}
            </Text>
            {isPurchasing ? (
              <ActivityIndicator />
            ) : (
              <View className="bg-primary h-10 w-full rounded-2xl items-center justify-center">
                <Text className="text-sm font-roobert-semibold text-primary-foreground">
                  {t('billing.purchase')}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

