/**
 * Billing Cancel Screen
 * 
 * Shown when checkout is cancelled
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { XCircle } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

export default function CancelScreen() {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="size-20 rounded-full bg-muted items-center justify-center mb-6">
        <Icon as={XCircle} size={48} className="text-muted-foreground" />
      </View>

      <Text className="text-2xl font-roobert-bold text-foreground text-center mb-2">
        {t('billing.checkoutCancelled')}
      </Text>

      <Text className="text-base font-roobert text-muted-foreground text-center mb-8">
        No charges were made
      </Text>

      <Pressable
        onPress={() => router.back()}
        className="bg-primary h-12 px-8 rounded-xl items-center justify-center"
      >
        <Text className="text-base font-roobert-semibold text-primary-foreground">
          {t('billing.returnToApp')}
        </Text>
      </Pressable>
    </View>
  );
}

