import React, { memo, useState, useEffect } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Sparkles, Zap } from 'lucide-react-native';
import { getOfferingById } from '@/lib/billing';
import type { PurchasesPackage } from 'react-native-purchases';

const CREDIT_MULTIPLIER = 100;
const CREDIT_PACKAGES = [
  { amount: 10, label: 'Starter' },
  { amount: 25, label: 'Plus' },
  { amount: 50, label: 'Popular', popular: true },
  { amount: 100, label: 'Pro' },
  { amount: 200, label: 'Business' },
  { amount: 500, label: 'Enterprise' },
];

interface CreditPackagesProps {
  onPurchase: (amount: number, packageId?: string) => void;
  purchasing: number | null;
  t: (key: string) => string;
  useRevenueCat?: boolean;
  offeringId?: string;
}

interface RevenueCatCreditPackage {
  amount: number;
  label: string;
  popular?: boolean;
  package: PurchasesPackage;
  price: string;
  priceValue: number;
}

const PackageCard = memo(({ 
  pkg, 
  isPurchasing, 
  onPress,
  price 
}: { 
  pkg: typeof CREDIT_PACKAGES[0]; 
  isPurchasing: boolean; 
  onPress: () => void;
  price?: string;
}) => {
  const displayAmount = pkg.amount * CREDIT_MULTIPLIER || 0;
  
  return (
    <View className="relative">
      {pkg.popular && (
        <View className="absolute -top-2 left-4 z-10 h-5 px-3 items-center justify-center rounded-full bg-primary">
          <Text className="text-[11px] font-roobert-semibold text-primary-foreground tracking-wide">POPULAR</Text>
        </View>
      )}
      <Pressable
        onPress={onPress}
        disabled={isPurchasing}
        className={`rounded-3xl p-4 active:opacity-80 ${
          pkg.popular 
            ? 'bg-primary/20 border border-primary' 
            : 'bg-primary/10'
        }`}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <Text className={`text-3xl font-roobert-semibold tracking-tight ${
              pkg.popular ? 'text-primary' : 'text-foreground'
            }`}>
              {displayAmount.toLocaleString()}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground">
              credits
            </Text>
            <Text className={`text-base font-roobert-semibold mt-1 ${
              pkg.popular ? 'text-primary' : 'text-foreground'
            }`}>
              {price || `$${pkg.amount}`}
            </Text>
          </View>
          
          {isPurchasing ? (
            <View className="h-10 w-20 items-center justify-center rounded-2xl bg-muted">
              <ActivityIndicator />
            </View>
          ) : (
            <View className="h-10 px-6 items-center justify-center rounded-2xl bg-primary">
              <Text className="text-sm font-roobert-semibold text-primary-foreground">
                Buy
              </Text>
            </View>
          )}
        </View>
      </Pressable>
    </View>
  );
});

PackageCard.displayName = 'PackageCard';

function CreditPackagesComponent({ 
  onPurchase, 
  purchasing, 
  useRevenueCat = false,
  offeringId = 'topups'
}: CreditPackagesProps) {
  const [rcPackages, setRcPackages] = useState<RevenueCatCreditPackage[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (useRevenueCat) {
      loadRevenueCatPackages();
    }
  }, [useRevenueCat, offeringId]);

  const loadRevenueCatPackages = async () => {
    try {
      setLoading(true);
      console.log(`💰 Loading credit packages from offering: ${offeringId}`);
      const offering = await getOfferingById(offeringId, true);
      
      if (offering) {
        const packages = offering.availablePackages
          .map(pkg => {
            const amountMatch = pkg.identifier.match(/(\d+)/);
            let amount = amountMatch ? parseInt(amountMatch[1]) : 0;
            
            if (amount === 0) {
              amount = Math.floor(pkg.product.price);
            }
            
            const hardcodedPkg = CREDIT_PACKAGES.find(p => p.amount === amount);
            
            return {
              amount,
              label: hardcodedPkg?.label || `${amount} Credits`,
              popular: hardcodedPkg?.popular || false,
              package: pkg,
              price: pkg.product.priceString,
              priceValue: pkg.product.price,
            };
          })
          .sort((a, b) => a.amount - b.amount);
        
        setRcPackages(packages);
        console.log('✅ Loaded RevenueCat packages:', packages.length);
      } else {
        console.warn(`⚠️ No offering found for: ${offeringId}`);
      }
    } catch (error) {
      console.error('❌ Error loading RevenueCat packages:', error);
    } finally {
      setLoading(false);
    }
  };

  if (useRevenueCat && loading) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="large" />
        <Text className="mt-4 text-sm text-muted-foreground">Loading packages...</Text>
      </View>
    );
  }

  if (useRevenueCat && rcPackages.length === 0 && !loading) {
    return (
      <View className="items-center justify-center py-12 bg-muted/30 rounded-3xl">
        <Text className="text-sm text-muted-foreground">No packages available</Text>
      </View>
    );
  }

  if (useRevenueCat) {
    return (
      <View className="gap-3">
        {rcPackages.map((pkg) => (
          <PackageCard
            key={pkg.package.identifier}
            pkg={pkg}
            isPurchasing={purchasing === pkg.amount}
            onPress={() => onPurchase(pkg.amount, pkg.package.identifier)}
            price={pkg.price}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="gap-3">
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

