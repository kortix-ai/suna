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
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  FadeIn,
  withDelay,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

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
  index?: number;
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
  index = 0,
}: PricingTierCardProps) {
  const isCurrentPlan = isAuthenticated && 
    currentSubscription?.tier_key === tier.id &&
    currentSubscription?.subscription?.status === 'active';

  const buttonScale = useSharedValue(1);

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const handlePress = () => {
    if (isLoading || isCurrentPlan) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPlanSelect?.(tier.id);
    if (onSubscribe) {
      onSubscribe(tier.id);
    }
  };

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
    <AnimatedView 
      entering={FadeIn.duration(600).delay(200 + index * 100)}
      className={`bg-card border ${tier.isPopular ? 'border-primary/30' : 'border-border'} rounded-2xl p-6 relative w-full`}
    >
      {tier.isPopular && (
        <View className="absolute top-4 right-4 bg-primary/10 px-3 py-1.5 rounded-full z-10">
          <Text className="text-[11px] font-roobert-semibold text-primary uppercase tracking-wide">
            Popular
          </Text>
        </View>
      )}

      <View className="mb-4">
        <TierBadge tier={tierType || 'Basic'} size="small" />
      </View>

      <View className="mb-6">
        <View className="flex-row items-baseline gap-1 mb-1">
          <Text className="text-5xl font-roobert-semibold text-foreground tracking-tight">
            {displayPrice}
          </Text>
          {displayPrice !== '$0' && (
            <Text className="text-base text-muted-foreground font-roobert">
              /mo
            </Text>
          )}
        </View>
      </View>

      {tier.features && tier.features.length > 0 && (
        <View className="mb-6 gap-3">
          {tier.features.map((feature, idx) => (
            <View key={idx} className="flex-row items-start gap-3">
              <View className="mt-0.5">
                <Icon as={Check} size={18} className="text-foreground" strokeWidth={2.5} />
              </View>
              <Text className="text-[15px] text-foreground flex-1 font-roobert leading-snug">
                {feature}
              </Text>
            </View>
          ))}
        </View>
      )}

      <AnimatedPressable
        onPress={handlePress}
        disabled={isLoading || isCurrentPlan}
        onPressIn={() => {
          if (!isLoading && !isCurrentPlan) {
            buttonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
          }
        }}
        onPressOut={() => {
          buttonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={[
          buttonAnimatedStyle,
          {
            opacity: isCurrentPlan ? 0.6 : 1,
          }
        ]}
        className={`w-full h-14 rounded-2xl items-center justify-center ${
          isCurrentPlan 
            ? 'bg-muted' 
            : tier.isPopular
            ? 'bg-primary'
            : 'bg-foreground'
        }`}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text className={`text-[15px] font-roobert-semibold ${
            isCurrentPlan ? 'text-muted-foreground' : tier.isPopular ? 'text-primary-foreground' : 'text-background'
          }`}>
            {isCurrentPlan ? 'Current Plan' : tier.buttonText || 'Select Plan'}
          </Text>
        )}
      </AnimatedPressable>
    </AnimatedView>
  );
}
