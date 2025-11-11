/**
 * Billing Period Toggle Component
 * 
 * Matches frontend's BillingPeriodToggle design
 * Shows Monthly and Yearly options with 15% off badge
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import type { BillingPeriod } from '@/lib/billing';
import * as Haptics from 'expo-haptics';

interface BillingPeriodToggleProps {
  billingPeriod: BillingPeriod;
  setBillingPeriod: (period: BillingPeriod) => void;
}

export function BillingPeriodToggle({
  billingPeriod,
  setBillingPeriod,
}: BillingPeriodToggleProps) {
  const isYearly = billingPeriod === 'yearly_commitment';

  return (
    <View className="flex-row items-center gap-2">
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setBillingPeriod('monthly');
        }}
        className={`h-10 px-4 rounded-xl border-[1.5px] items-center justify-center ${
          billingPeriod === 'monthly'
            ? 'bg-primary border-primary'
            : 'bg-transparent border-border'
        }`}
      >
        <Text
          className={`text-sm font-roobert-medium ${
            billingPeriod === 'monthly'
              ? 'text-primary-foreground'
              : 'text-foreground'
          }`}
        >
          Monthly
        </Text>
      </Pressable>

      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setBillingPeriod('yearly_commitment');
        }}
        className={`h-10 px-4 rounded-xl border-[1.5px] flex-row items-center gap-1.5 ${
          billingPeriod === 'yearly_commitment'
            ? 'bg-primary border-primary'
            : 'bg-transparent border-border'
        }`}
      >
        <Text
          className={`text-sm font-roobert-medium ${
            billingPeriod === 'yearly_commitment'
              ? 'text-primary-foreground'
              : 'text-foreground'
          }`}
        >
          Yearly
        </Text>
        <View
          className={`px-1.5 py-0.5 rounded-full ${
            isYearly
              ? 'bg-background/90'
              : 'bg-muted/80'
          }`}
        >
          <Text className="text-xs font-roobert-medium text-primary">
            15% off
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

