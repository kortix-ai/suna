import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TriggerDetailPage } from '@/components/pages/TriggerDetailPage';

export default function TriggerDetailScreen() {
  const { triggerId } = useLocalSearchParams<{ triggerId: string }>();
  const router = useRouter();

  if (!triggerId) {
    router.back();
    return null;
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <TriggerDetailPage triggerId={triggerId} />
    </SafeAreaView>
  );
}




