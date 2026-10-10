'use client';

import { useParams } from 'next/navigation';

import { FilesView } from '@/features/drives/files-view';

/**
 * /projects/[id]/customize/files — the project's shared folders (its drive),
 * as a Customize tab: browse the tree, and for each folder choose who can
 * open it, the same way an agent's page chooses who can use the agent.
 */
export default function ProjectCustomizeFilesPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <FilesView projectId={projectId} />
    </div>
  );
}
