'use client';

import { ProjectSessionsView } from '@kortix/ui/workspace';
import { useParams } from 'next/navigation';

export default function ProjectSessionsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectSessionsView projectId={projectId} />
    </div>
  );
}
