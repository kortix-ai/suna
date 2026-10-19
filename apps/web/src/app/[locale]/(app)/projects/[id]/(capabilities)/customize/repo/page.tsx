'use client';

import { useParams } from 'next/navigation';

import { ProjectFilesView } from '@/features/workspace/project-layout/project-files-view';

/**
 * /projects/[id]/customize/repo — the project's git repo, a Customize tab for
 * admins when Volumes is on. The repo is configuration (agents, skills,
 * kortix.yaml), not a place people keep files: that is Drive.
 */
export default function ProjectCustomizeRepoPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectFilesView projectId={projectId} />
    </div>
  );
}
