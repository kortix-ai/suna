'use client';

import { TaskCenter } from '@/features/tasks/task-center';
import { useParams } from 'next/navigation';

/** Durable AI coworker tasks. The view and every discovery surface fail closed on `agi`. */
export default function ProjectTasksPage() {
  const { id: projectId } = useParams<{ id: string }>();
  return <TaskCenter projectId={projectId} />;
}
