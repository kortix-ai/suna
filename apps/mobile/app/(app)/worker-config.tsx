import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WorkerConfigPage } from '@/components/pages/WorkerConfigPage';

export default function WorkerConfigScreen() {
  const { workerId, view } = useLocalSearchParams<{
    workerId: string;
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers';
  }>();
  const router = useRouter();

  if (!workerId) {
    router.back();
    return null;
  }

  return <WorkerConfigPage workerId={workerId} initialView={view} />;
}
