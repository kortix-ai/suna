/**
 * Billing Period Toggle Component
 * 
 * Matches frontend's BillingPeriodToggle design
 * Shows Monthly and Yearly options with 15% off badge
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import type { BillingPeriod } from '@/lib/billing';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface BillingPeriodToggleProps {
  billingPeriod: BillingPeriod;
  setBillingPeriod: (period: BillingPeriod) => void;
}

export function BillingPeriodToggle({
  billingPeriod,
  setBillingPeriod,
}: BillingPeriodToggleProps) {
  const { t } = useLanguage();
  const isYearly = billingPeriod === 'yearly_commitment';
  
  const monthlyScale = useSharedValue(1);
  const yearlyScale = useSharedValue(1);

  const monthlyStyle = useAnimatedStyle(() => ({
    transform: [{ scale: monthlyScale.value }],
  }));

  const yearlyStyle = useAnimatedStyle(() => ({
    transform: [{ scale: yearlyScale.value }],
  }));

  return (
    <View className="flex-row items-center bg-muted/20 p-0.5 rounded-full">
      <AnimatedPressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setBillingPeriod('monthly');
        }}
        onPressIn={() => {
          monthlyScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          monthlyScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={monthlyStyle}
        className={`flex-1 h-7 px-2 rounded-full items-center justify-center ${
          billingPeriod === 'monthly'
            ? 'bg-foreground'
            : 'bg-transparent'
        }`}
      >
        <Text
          className={`text-xs font-roobert-medium ${
            billingPeriod === 'monthly'
              ? 'text-background'
              : 'text-muted-foreground'
          }`}
        >
          {t('billing.monthly')}
        </Text>
      </AnimatedPressable>

      <AnimatedPressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setBillingPeriod('yearly_commitment');
        }}
        onPressIn={() => {
          yearlyScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          yearlyScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={yearlyStyle}
        className={`flex-1 h-7 px-2 rounded-full flex-row items-center justify-center gap-1 ${
          billingPeriod === 'yearly_commitment'
            ? 'bg-foreground'
            : 'bg-transparent'
        }`}
      >
        <Text
          className={`text-xs font-roobert-medium ${
            billingPeriod === 'yearly_commitment'
              ? 'text-background'
              : 'text-muted-foreground'
          }`}
        >
          {t('billing.yearlyCommitment')}
        </Text>
        <View
          className={`px-1 py-0.5 rounded-full ${
            isYearly
              ? 'bg-primary/20'
              : 'bg-primary/10'
          }`}
        >
          <Text className={`text-[9px] font-roobert-semibold ${
            isYearly ? 'text-primary' : 'text-primary'
          }`}>
            {t('billing.save15Percent')}
          </Text>
        </View>
      </AnimatedPressable>
    </View>
  );
}