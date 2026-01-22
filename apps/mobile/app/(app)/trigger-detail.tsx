import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { TriggerDetailPage } from '@/components/pages/TriggerDetailPage';

export default function TriggerDetailScreen() {
  const { triggerId } = useLocalSearchParams<{ triggerId: string }>();
  const router = useRouter();

  if (!triggerId) {
    router.back();
    return null;
  }

  return <TriggerDetailPage triggerId={triggerId} />;
}




