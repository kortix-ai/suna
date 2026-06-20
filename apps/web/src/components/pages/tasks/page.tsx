'use client';

import { use, useCallback } from 'react';
import { TaskDetailView } from '@/components/kortix/task-detail-view';
import { useIsRouteActive } from '@/hooks/utils/use-is-route-active';
import { openTabAndNavigate } from '@/stores/tab-store';

export default function TaskDetailPage({ params }: { params?: Promise<{ id: string }> }) {
  const { id: raw } = params ? use(params) : { id: '' };
  const taskId = raw ? decodeURIComponent(raw) : '';
  const isActive = useIsRouteActive(`/tasks/${encodeURIComponent(taskId)}`);

  const goBack = useCallback(() => {
    openTabAndNavigate({
      id: 'page:/workspace',
      title: 'Workspace',
      type: 'page',
      href: '/workspace',
    });
  }, []);

  return <TaskDetailView taskId={taskId} onClose={goBack} pollingEnabled={isActive} />;
}
