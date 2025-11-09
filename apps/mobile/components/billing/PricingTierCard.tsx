/**
 * Pricing Tier Card Component
 * 
 * Simple card display for pricing tiers
 */

import React from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Check } from 'lucide-react-native';
import type { PricingTier, BillingPeriod } from '@/lib/billing';
import type { SubscriptionInfo } from '@/lib/billing/api';
import { TierBadge } from '@/components/menu/TierBadge';
import type { TierType } from '@/components/menu/types';
import * as Haptics from 'expo-haptics';

interface PricingTierCardProps {
  tier: PricingTier;
  displayPrice: string;
  billingPeriod: BillingPeriod;
  currentSubscription: SubscriptionInfo | null;
  isLoading: boolean;
  isFetchingPlan: boolean;
  onPlanSelect?: (planId: string) => void;
  onSubscribe?: (tierKey: string, isDowngrade?: boolean) => void;
  onSubscriptionUpdate?: () => void;
  isAuthenticated?: boolean;
  currentBillingPeriod?: BillingPeriod | null;
  insideDialog?: boolean;
  t: (key: string, defaultValue?: string) => string;
}

export function PricingTierCard({
  tier,
  displayPrice,
  billingPeriod,
  currentSubscription,
  isLoading,
  isFetchingPlan,
  onPlanSelect,
  onSubscribe,
  onSubscriptionUpdate,
  isAuthenticated = false,
  currentBillingPeriod = null,
  insideDialog = false,
  t,
}: PricingTierCardProps) {
  const isCurrentPlan = isAuthenticated && 
    currentSubscription?.tier_key === tier.id &&
    currentSubscription?.subscription?.status === 'active';

  const handlePress = () => {
    if (isLoading || isCurrentPlan) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPlanSelect?.(tier.id);
    if (onSubscribe) {
      onSubscribe(tier.id);
    }
  };

  // Map tier name to TierType for TierBadge component
  const getTierType = (): TierType | null => {
    const tierName = tier.name.toLowerCase();
    if (tierName === 'basic' || tierName === 'free') return 'Basic';
    if (tierName === 'plus') return 'Plus';
    if (tierName === 'pro' || tierName === 'business') return 'Pro';
    if (tierName === 'ultra') return 'Ultra';
    return null;
  };

  const tierType = getTierType();

  return (
    <View className="bg-card border border-border rounded-xl p-4 relative w-full">
      {/* Popular Badge - Top Right Corner */}
      {tier.isPopular && (
        <View className="absolute top-3 right-3 bg-muted/50 px-2 py-1 rounded-full z-10">
          <Text className="text-[10px] font-roobert-medium text-muted-foreground uppercase tracking-wide">
            Popular
          </Text>
        </View>
      )}

      {/* Tier Badge - Plan Name with Icon */}
      <View className="mb-3">
        <TierBadge tier={tierType || 'Basic'} size="small" />
      </View>

      {/* Price */}
      <View className="mb-4">
        <Text className="text-4xl font-roobert-semibold text-foreground">
          {displayPrice}
        </Text>
        {displayPrice !== '$0' && (
          <Text className="text-sm text-muted-foreground mt-1">
            /month
          </Text>
        )}
      </View>

      {/* Features */}
      {tier.features && tier.features.length > 0 && (
        <View className="mb-4 gap-2">
          {tier.features.map((feature, idx) => (
            <View key={idx} className="flex-row items-center gap-2">
              <Icon as={Check} size={16} className="text-foreground" strokeWidth={2} />
              <Text className="text-sm text-foreground flex-1">
                {feature}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Button */}
      <Pressable
        onPress={handlePress}
        disabled={isLoading || isCurrentPlan}
        className={`w-full h-10 rounded-lg items-center justify-center ${
          isCurrentPlan 
            ? 'bg-muted opacity-50' 
            : isLoading 
            ? 'bg-primary opacity-70'
            : 'bg-primary'
        }`}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text className={`text-sm font-roobert-medium ${
            isCurrentPlan ? 'text-muted-foreground' : 'text-primary-foreground'
          }`}>
            {isCurrentPlan ? 'Current Plan' : tier.buttonText || 'Select Plan'}
          </Text>
        )}
      </Pressable>
    </View>
  );
}
