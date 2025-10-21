/**
 * Billing Success Screen
 * 
 * Shown after successful checkout
 */

import React, { useEffect } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle } from 'lucide-react-native';
import { useBillingContext } from '@/contexts/BillingContext';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';

export default function SuccessScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { refetchAll } = useBillingContext();
  const params = useLocalSearchParams<{ context?: string }>();

  useEffect(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    refetchAll();
  }, []);

  const getMessage = () => {
    switch (params.context) {
      case 'trial':
        return 'Trial activated successfully!';
      case 'credits':
        return t('billing.purchaseComplete');
      default:
        return 'Subscription updated successfully!';
    }
  };

  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="size-20 rounded-full bg-green-500/10 items-center justify-center mb-6">
        <Icon as={CheckCircle} size={48} className="text-green-600" />
      </View>

      <Text className="text-2xl font-roobert-bold text-foreground text-center mb-4">
        {getMessage()}
      </Text>

      <Pressable
        onPress={() => router.replace('/home')}
        className="bg-primary h-12 px-8 rounded-xl items-center justify-center mt-4"
      >
        <Text className="text-base font-roobert-semibold text-primary-foreground">
          {t('common.done')}
        </Text>
      </Pressable>
    </View>
  );
}

