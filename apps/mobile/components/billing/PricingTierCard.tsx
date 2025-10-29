/**
 * Pricing Tier Card Component
 * 
 * Matches Figma design: minimal, clean, card-based
 * Supports both light and dark mode
 * Used in BillingContent, Onboarding, and any billing UI
 */

import React from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Check } from 'lucide-react-native';
import type { PricingTier } from '@/lib/billing';
import * as Haptics from 'expo-haptics';

interface PricingTierCardProps {
  tier: PricingTier;
  displayPrice: string;
  billingPeriod: 'monthly' | 'yearly_commitment';
  isSelected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  simplified?: boolean;
  t: (key: string, defaultValue?: string) => string;
}

export function PricingTierCard({
  tier,
  displayPrice,
  billingPeriod,
  isSelected,
  onSelect,
  disabled = false,
  simplified = false,
  t,
}: PricingTierCardProps) {
  const featuresToShow = simplified ? tier.features.slice(0, 3) : tier.features;

  const handlePress = () => {
    if (disabled || isSelected) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled || isSelected}
      className="mb-3"
    >
      {/* Card - Adapts to dark mode */}
      <View className={`bg-secondary border-2 rounded-2xl pb-4 pt-6 px-4 ${
        isSelected ? 'border-primary' : 'border-border'
      }`}>
        {/* Tier Name & Badge */}
        <View className="flex-row items-center gap-2 mb-2">
          <Text className="text-lg font-roobert-semibold text-foreground">
            {tier.displayName}
          </Text>
          {tier.isPopular && (
            <View className="bg-primary/10 px-2 py-0.5 rounded-full">
              <Text className="text-xs font-roobert-medium text-primary">
                Popular
              </Text>
            </View>
          )}
        </View>

        {/* Price */}
        <View className="pt-4 pb-6">
          <Text className="text-4xl font-roobert-semibold text-foreground">
            {displayPrice}
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground mt-2">
            per month
          </Text>
        </View>

        {/* Features */}
        <View className="gap-3 py-2 mb-3">
          {featuresToShow.map((feature: string, idx: number) => (
            <View key={idx} className="flex-row items-center gap-2">
              <Icon as={Check} size={16} className="text-primary" strokeWidth={2} />
              <Text className="flex-1 text-sm font-roobert text-foreground/80">
                {feature}
              </Text>
            </View>
          ))}
        </View>

        {/* Select Button */}
        <Pressable
          onPress={handlePress}
          disabled={disabled || isSelected}
          className={`h-12 rounded-xl items-center justify-center ${
            isSelected 
              ? 'bg-primary/20 border-2 border-primary' 
              : disabled
              ? 'bg-muted'
              : 'bg-primary'
          }`}
        >
          {disabled && !isSelected ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text className={`text-sm font-roobert-medium ${
              isSelected 
                ? 'text-primary' 
                : 'text-primary-foreground'
            }`}>
              {isSelected ? t('billing.currentActive', 'Current Plan') : t('billing.selectPlan', 'Select')}
            </Text>
          )}
        </Pressable>
      </View>
    </Pressable>
  );
}

