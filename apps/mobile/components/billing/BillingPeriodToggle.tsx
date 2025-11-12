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
    <View className="flex-row items-center gap-3 bg-muted/30 p-1.5 rounded-2xl">
      <AnimatedPressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setBillingPeriod('monthly');
        }}
        onPressIn={() => {
          monthlyScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          monthlyScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={monthlyStyle}
        className={`h-11 px-5 rounded-xl items-center justify-center ${
          billingPeriod === 'monthly'
            ? 'bg-primary'
            : 'bg-transparent'
        }`}
      >
        <Text
          className={`text-[15px] font-roobert-semibold ${
            billingPeriod === 'monthly'
              ? 'text-primary-foreground'
              : 'text-muted-foreground'
          }`}
        >
          Monthly
        </Text>
      </AnimatedPressable>

      <AnimatedPressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setBillingPeriod('yearly_commitment');
        }}
        onPressIn={() => {
          yearlyScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          yearlyScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={yearlyStyle}
        className={`h-11 px-5 rounded-xl flex-row items-center gap-2 ${
          billingPeriod === 'yearly_commitment'
            ? 'bg-primary'
            : 'bg-transparent'
        }`}
      >
        <Text
          className={`text-[15px] font-roobert-semibold ${
            billingPeriod === 'yearly_commitment'
              ? 'text-primary-foreground'
              : 'text-muted-foreground'
          }`}
        >
          Yearly
        </Text>
        <View
          className={`px-2 py-1 rounded-full ${
            isYearly
              ? 'bg-background/90'
              : 'bg-primary/10'
          }`}
        >
          <Text className={`text-[11px] font-roobert-semibold ${
            isYearly ? 'text-primary' : 'text-primary'
          }`}>
            15% off
          </Text>
        </View>
      </AnimatedPressable>
    </View>
  );
}

