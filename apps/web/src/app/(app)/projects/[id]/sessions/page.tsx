'use client';

import { useParams } from 'next/navigation';
import { ProjectSessionsView } from '@/features/workspace/project-sessions/project-sessions-view';

export default function ProjectSessionsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectSessionsView projectId={projectId} />
      </div>
  );
}
