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
import type { PricingTier } from '@/lib/billing/types';

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

  return (
    <Pressable
      onPress={onSelect}
      disabled={disabled || isSelected}
      className="mb-3"
    >
      {/* White Card with Border - Adapts to dark mode */}
      <View className="bg-[#F8F8F8] dark:bg-[#1A1A1D] border-[1.5px] border-[rgba(0,0,0,0.12)] dark:border-[rgba(255,255,255,0.12)] rounded-[18px] pb-[18px] pt-[24px] px-[18px]">
        {/* Tier Name & Badge */}
        <View className="flex-row items-center gap-[6px] mb-[6px]">
          {/* Pro Badge (black with logo in light, white in dark) */}
          {tier.isPopular && (
            <View className="bg-[#121215] dark:bg-[#F8F8F8] flex-row items-center gap-[5px] px-[10px] py-[6px] rounded-[16px] h-[24px]">
              <View className="w-[11px] h-[9px] bg-white/90 dark:bg-black/90 rounded-[2px]" />
              <Text className="text-[12px] font-roobert-medium text-[#F8F8F8] dark:text-[#121215]">
                {tier.displayName}
              </Text>
            </View>
          )}
          
          {/* Plus/Business - Just text with icon */}
          {!tier.isPopular && (
            <View className="flex-row items-center gap-[5px]">
              <View className="w-[15px] h-[13px] bg-black/10 dark:bg-white/10 rounded-[2px]" />
              <Text className="text-[17px] font-roobert-medium text-[#121215] dark:text-[#F8F8F8]">
                {tier.displayName}
              </Text>
            </View>
          )}

          {/* Popular Badge */}
          {tier.isPopular && (
            <View className="bg-[#F8F8F8] dark:bg-[#1A1A1D] border-[0.75px] border-[#E5E5E5] dark:border-[rgba(255,255,255,0.12)] px-[9px] py-[3px] rounded-[18px] h-[24px] items-center justify-center">
              <Text className="text-[10.5px] font-roobert-semibold text-[#121215] dark:text-[#F8F8F8] opacity-80 tracking-[-0.105px]">
                Popular
              </Text>
            </View>
          )}
        </View>

        {/* Price */}
        <View className="pt-[18px] pb-[24px]">
          <Text className="text-[48px] font-roobert-medium text-[#121215] dark:text-[#F8F8F8] leading-[1.2]">
            {displayPrice}
          </Text>
          <Text className="text-[12px] font-roobert-medium text-[#121215] dark:text-[#F8F8F8] opacity-70 mt-[18px]">
            per month
          </Text>
        </View>

        {/* Features */}
        <View className="space-y-[12px] py-[6px] mb-[12px]">
          {featuresToShow.map((feature, idx) => (
            <View key={idx} className="flex-row items-center gap-[9px]">
              {/* Green checkmark icon */}
              <View className="w-[15px] h-[15px] items-center justify-center">
                <Icon as={Check} size={15} className="text-green-600 dark:text-green-500" strokeWidth={2.5} />
              </View>
              <Text className="flex-1 text-[12px] font-roobert-medium text-[#121215] dark:text-[#F8F8F8] opacity-70">
                {feature}
              </Text>
            </View>
          ))}
        </View>

        {/* Select Button - Inverts in dark mode */}
        <Pressable
          onPress={onSelect}
          disabled={disabled || isSelected}
          className={`h-[48px] rounded-[16px] items-center justify-center ${
            isSelected 
              ? 'bg-[#121215]/30 dark:bg-[#F8F8F8]/30' 
              : 'bg-[#121215] dark:bg-[#F8F8F8]'
          }`}
        >
          {disabled && !isSelected ? (
            <ActivityIndicator color="#F8F8F8" size="small" />
          ) : (
            <Text className={`text-[14px] font-roobert-medium ${
              isSelected 
                ? 'text-[#F8F8F8] dark:text-[#121215]' 
                : 'text-[#F8F8F8] dark:text-[#121215]'
            }`}>
              {isSelected ? t('billing.currentActive', 'Current') : 'Select'}
            </Text>
          )}
        </Pressable>
      </View>
    </Pressable>
  );
}

