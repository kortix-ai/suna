'use client';

import { useParams } from 'next/navigation';

import { ProjectFilesView } from '@/features/workspace/project-layout/project-files-view';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

/**
 * /projects/[id]/files — the standalone Files page (Google-Drive-style browser
 * over the project repo). A regular routed page inside the project shell, NOT
 * a Customize section: any member can browse files, no editor access needed.
 */
export default function ProjectFilesPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <ProjectShell projectId={projectId}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectFilesView projectId={projectId} />
      </div>
    </ProjectShell>
  );
}
