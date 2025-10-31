/**
 * Trial Card Component
 * 
 * Reusable card for displaying the free trial option
 * Used in BillingContent, Onboarding, and any billing UI
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Sparkles, CheckCircle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface TrialCardProps {
  onPress: () => void;
  disabled?: boolean;
  t: (key: string, defaultValue?: string) => string;
}

export function TrialCard({ onPress, disabled = false, t }: TrialCardProps) {
  const handlePress = () => {
    if (disabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className="p-6 bg-primary rounded-2xl mb-4"
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center gap-2">
          <Icon as={Sparkles} size={24} className="text-primary-foreground" />
          <Text className="text-lg font-roobert-semibold text-primary-foreground">
            {t('billing.trial.badge', '7-Day Free Trial')}
          </Text>
        </View>
        <Icon as={CheckCircle} size={24} className="text-primary-foreground" />
      </View>
      
      {/* Description */}
      <Text className="text-primary-foreground/90 mb-4">
        {t('billing.trial.description', 'Try all features free for 7 days')}
      </Text>

      {/* Benefits */}
      <View className="space-y-2">
        <View className="flex-row items-center gap-2">
          <Icon as={CheckCircle} size={16} className="text-primary-foreground" />
          <Text className="text-primary-foreground/90 text-sm">
            {t('billing.trial.benefit1', 'Unlimited agents')}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Icon as={CheckCircle} size={16} className="text-primary-foreground" />
          <Text className="text-primary-foreground/90 text-sm">
            {t('billing.trial.benefit2', 'All AI models')}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Icon as={CheckCircle} size={16} className="text-primary-foreground" />
          <Text className="text-primary-foreground/90 text-sm">
            {t('billing.trial.benefit3', 'Priority support')}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

