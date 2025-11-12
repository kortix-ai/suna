/**
 * Credit Packages Component
 * 
 * Displays available credit packages for purchase
 */

import React, { memo } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Sparkles, Zap } from 'lucide-react-native';

const CREDIT_PACKAGES = [
  { amount: 10, label: 'Starter' },
  { amount: 25, label: 'Plus' },
  { amount: 50, label: 'Popular', popular: true },
  { amount: 100, label: 'Pro' },
  { amount: 200, label: 'Business' },
  { amount: 500, label: 'Enterprise' },
];

interface CreditPackagesProps {
  onPurchase: (amount: number) => void;
  purchasing: number | null;
  t: (key: string) => string;
}

const PackageCard = memo(({ 
  pkg, 
  isPurchasing, 
  onPress 
}: { 
  pkg: typeof CREDIT_PACKAGES[0]; 
  isPurchasing: boolean; 
  onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    disabled={isPurchasing}
    className={`rounded-3xl p-5 active:opacity-80 ${
      pkg.popular 
        ? 'bg-primary border-2 border-primary' 
        : 'bg-primary/5'
    }`}
  >
    <View className="flex-row items-center justify-between">
      <View className="flex-1">
        <View className="flex-row items-center gap-2 mb-1.5">
          <Text className={`text-3xl font-roobert-semibold tracking-tight ${
            pkg.popular ? 'text-primary-foreground' : 'text-foreground'
          }`}>
            ${pkg.amount}
          </Text>
          {pkg.popular && (
            <View className="h-6 w-6 items-center justify-center rounded-full bg-primary-foreground/20">
              <Icon as={Zap} size={14} className="text-primary-foreground" strokeWidth={3} />
            </View>
          )}
        </View>
        <Text className={`text-sm font-roobert-medium mb-0.5 ${
          pkg.popular ? 'text-primary-foreground' : 'text-foreground'
        }`}>
          {pkg.label}
        </Text>
        <Text className={`text-xs font-roobert ${
          pkg.popular ? 'text-primary-foreground/70' : 'text-muted-foreground'
        }`}>
          {pkg.amount.toLocaleString()} credits
        </Text>
      </View>
      
      {isPurchasing ? (
        <View className={`h-11 w-20 items-center justify-center rounded-full ${
          pkg.popular ? 'bg-primary-foreground/20' : 'bg-muted'
        }`}>
          <ActivityIndicator color={pkg.popular ? '#fff' : '#000'} />
        </View>
      ) : (
        <View className={`h-11 px-6 items-center justify-center rounded-full ${
          pkg.popular ? 'bg-primary-foreground' : 'bg-primary'
        }`}>
          <Text className={`text-sm font-roobert-semibold ${
            pkg.popular ? 'text-primary' : 'text-primary-foreground'
          }`}>
            Buy
          </Text>
        </View>
      )}
    </View>
  </Pressable>
));

PackageCard.displayName = 'PackageCard';

function CreditPackagesComponent({ onPurchase, purchasing }: CreditPackagesProps) {
  return (
    <View className="gap-4">
      {CREDIT_PACKAGES.map((pkg) => (
        <PackageCard
          key={pkg.amount}
          pkg={pkg}
          isPurchasing={purchasing === pkg.amount}
          onPress={() => onPurchase(pkg.amount)}
        />
      ))}
    </View>
  );
}

export const CreditPackages = memo(CreditPackagesComponent);

