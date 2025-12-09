import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WorkerConfigPage } from '@/components/pages/WorkerConfigPage';

export default function WorkerConfigScreen() {
  const { workerId } = useLocalSearchParams<{ workerId: string }>();
  const router = useRouter();

  if (!workerId) {
    router.back();
    return null;
  }

  return <WorkerConfigPage workerId={workerId} />;
}

