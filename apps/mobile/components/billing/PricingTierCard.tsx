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
  // More sophisticated current plan detection
  const isCurrentPlan = isAuthenticated && 
    currentSubscription?.tier_key === tier.id &&
    currentSubscription?.subscription?.status === 'active';

  // Determine if this is an upgrade or downgrade
  const getCurrentPlanValue = (): number => {
    if (!currentSubscription?.tier_key) return 0;
    const tierValues: Record<string, number> = {
      'free': 0,
      'tier_2_20': 20,
      'tier_6_50': 50, 
      'tier_12_100': 100,
      'tier_25_200': 200,
    };
    return tierValues[currentSubscription.tier_key] || 0;
  };

  const getTargetPlanValue = (): number => {
    const tierValues: Record<string, number> = {
      'free': 0,
      'tier_2_20': 20,
      'tier_6_50': 50,
      'tier_12_100': 100, 
      'tier_25_200': 200,
    };
    return tierValues[tier.id] || 0;
  };

  const currentPlanValue = getCurrentPlanValue();
  const targetPlanValue = getTargetPlanValue();
  const isUpgrade = targetPlanValue > currentPlanValue;
  const isDowngrade = targetPlanValue < currentPlanValue;

  // Same tier but different billing period check
  const isSameTierDifferentPeriod = currentSubscription?.tier_key === tier.id && 
    currentBillingPeriod !== billingPeriod && 
    currentBillingPeriod !== null;

  const buttonScale = useSharedValue(1);

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const handlePress = () => {
    if (isLoading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPlanSelect?.(tier.id);
    if (onSubscribe) {
      onSubscribe(tier.id, isDowngrade);
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

  // Button styling and text logic
  const getButtonText = (): string => {
    if (!isAuthenticated) {
      return tier.buttonText || t('billing.getStarted');
    }
    
    if (isCurrentPlan && !isSameTierDifferentPeriod) {
      return t('billing.currentPlan');
    }
    
    if (isSameTierDifferentPeriod) {
      return billingPeriod === 'yearly_commitment' ? t('billing.upgrade') : t('billing.switchPlan');
    }
    
    if (isUpgrade) {
      return t('billing.upgrade');
    }
    
    if (isDowngrade) {
      return t('billing.downgrade');
    }
    
    return tier.buttonText || t('billing.getStarted');
  };

  const getButtonStyles = (): string => {
    if (!isAuthenticated) {
      return tier.isPopular ? 'bg-primary' : 'bg-foreground';
    }
    
    if (isCurrentPlan && !isSameTierDifferentPeriod) {
      return 'bg-muted/50 dark:bg-muted/30 border border-border/60 dark:border-border/40';
    }
    
    if (isSameTierDifferentPeriod || isUpgrade) {
      return tier.isPopular ? 'bg-primary' : 'bg-primary';
    }
    
    if (isDowngrade) {
      return 'bg-background border border-border';
    }
    
    return tier.isPopular ? 'bg-primary' : 'bg-foreground';
  };

  const getButtonTextColor = (): string => {
    if (!isAuthenticated) {
      return tier.isPopular ? 'text-primary-foreground' : 'text-background';
    }
    
    if (isCurrentPlan && !isSameTierDifferentPeriod) {
      return 'text-muted-foreground/80 dark:text-muted-foreground/70';
    }
    
    if (isSameTierDifferentPeriod || isUpgrade) {
      return 'text-primary-foreground';
    }
    
    if (isDowngrade) {
      return 'text-foreground';
    }
    
    return tier.isPopular ? 'text-primary-foreground' : 'text-background';
  };

  const getLoadingColor = (): string => {
    const styles = getButtonStyles();
    if (styles.includes('bg-primary')) return '#fff';
    if (styles.includes('bg-foreground')) return '#fff';
    return '#000';
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
        disabled={isLoading || (isCurrentPlan && !isSameTierDifferentPeriod)}
        onPressIn={() => {
          if (!isLoading && !(isCurrentPlan && !isSameTierDifferentPeriod)) {
            buttonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
          }
        }}
        onPressOut={() => {
          buttonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={[
          buttonAnimatedStyle,
          {
            opacity: (isCurrentPlan && !isSameTierDifferentPeriod) ? 0.6 : 1,
          }
        ]}
        className={`w-full h-12 rounded-3xl items-center justify-center ${
          getButtonStyles()
        }`}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={getLoadingColor()} />
        ) : (
          <Text className={`text-sm font-roobert-semibold ${getButtonTextColor()}`}>
            {getButtonText()}
          </Text>
        )}
      </AnimatedPressable>
    </AnimatedView>
  );
}
