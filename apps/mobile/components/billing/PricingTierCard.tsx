/**
 * Pricing Tier Card Component
 * 
 * Card display for pricing tiers - matches frontend design
 */

import React from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Check,
  Clock,
  Bot,
  FileText,
  Grid3X3,
  Diamond,
  Heart,
  Image as ImageIcon,
  Zap
} from 'lucide-react-native';
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
} from 'react-native-reanimated';
import { AnimatedTierBackground } from './AnimatedTierBackground';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Feature icon mapping (matching frontend)
const getFeatureIcon = (feature: string) => {
  const featureLower = feature.toLowerCase();

  if (featureLower.includes('token credits') || featureLower.includes('ai token')) {
    return Clock;
  }
  if (featureLower.includes('custom workers') || featureLower.includes('agents')) {
    return Bot;
  }
  if (featureLower.includes('private projects') || featureLower.includes('public projects')) {
    return FileText;
  }
  if (featureLower.includes('integrations') || featureLower.includes('100+')) {
    return Grid3X3;
  }
  if (featureLower.includes('premium ai models')) {
    return Diamond;
  }
  if (featureLower.includes('community support') || featureLower.includes('priority support')) {
    return Heart;
  }
  if (featureLower.includes('image') || featureLower.includes('video') || featureLower.includes('slides') || featureLower.includes('generation')) {
    return ImageIcon;
  }
  if (featureLower.includes('dedicated account manager')) {
    return Zap;
  }

  return Check;
};

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

  const tierType: TierType =
    tier.name.toLowerCase() === 'basic' || tier.name.toLowerCase() === 'free' ? 'Basic' :
      tier.name.toLowerCase() === 'plus' ? 'Plus' :
        tier.name.toLowerCase() === 'pro' || tier.name.toLowerCase() === 'business' ? 'Pro' :
          'Ultra';

  const isUltraTier = tier.name.toLowerCase() === 'ultra';

  return (
    <View className="w-[280px] mr-4 min-h-[380px]">
      <View
        className="bg-card border border-border rounded-[18px] p-4 flex-1 justify-between overflow-hidden"
      >
        {/* Animated Background for Ultra tier */}
        {isUltraTier && <AnimatedTierBackground variant="ultra" />}

        <View style={{ zIndex: 10, flex: 1, justifyContent: 'space-between' }}>
          <View>
            {/* Header */}
            <View className="mb-3">
              <View className="flex-row items-center justify-between mb-2">
                <TierBadge tier={tierType} size="small" />
                {tier.isPopular && (
                  <View className="bg-primary/10 px-2 py-1 rounded-full">
                    <Text className="text-[10px] font-roobert-semibold text-primary uppercase">
                      Popular
                    </Text>
                  </View>
                )}
              </View>

              {/* Price */}
              <View>
                <Text className="text-[40px] font-roobert-semibold text-foreground tracking-tight leading-[44px]">
                  {displayPrice}
                </Text>
                <View className="h-5 flex-row items-center gap-1">
                  {displayPrice !== '$0' && (
                    <>
                      <Text className="text-sm text-muted-foreground font-roobert">
                        per month
                      </Text>
                      {billingPeriod === 'yearly_commitment' && (
                        <Text className="text-xs text-muted-foreground/60 font-roobert">
                          • billed annually
                        </Text>
                      )}
                    </>
                  )}
                </View>
              </View>
            </View>

            {/* Features */}
            {tier.features && tier.features.length > 0 && (
              <View className="gap-2 mb-3">
                {tier.features.map((feature, idx) => {
                  const FeatureIcon = getFeatureIcon(feature);
                  return (
                    <View key={idx} className="flex-row items-start gap-2">
                      <View className="mt-0.5">
                        <Icon as={FeatureIcon} size={14} className="text-muted-foreground" strokeWidth={2} />
                      </View>
                      <Text className="text-[12px] text-foreground flex-1 font-roobert leading-tight">
                        {feature}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          {/* Button - Always at bottom */}
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
                zIndex: 10,
              }
            ]}
            className={`w-full h-11 rounded-xl items-center justify-center ${getButtonStyles()
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
        </View>
      </View>
    </View>
  );
}
