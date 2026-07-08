'use client';

import { useParams } from 'next/navigation';

import { FolderHomeView } from '@/features/workspace/project-layout/folder-home-view';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

/**
 * /projects/[id]/folders/[folderId] — a folder's home page. `folderId` is a
 * session-folder uuid for manual folders, or an auto-folder kind for the
 * virtual source folders (/folders/slack, /folders/email, /folders/schedule,
 * /folders/webhook, /folders/telegram).
 */
export default function ProjectFolderPage() {
  const { id: projectId, folderId } = useParams<{ id: string; folderId: string }>();

  return (
    <ProjectShell projectId={projectId}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <FolderHomeView projectId={projectId} folderKey={folderId} />
      </div>
    </ProjectShell>
  );
}
