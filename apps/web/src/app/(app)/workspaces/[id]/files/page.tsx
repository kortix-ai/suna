'use client';

import { useParams } from 'next/navigation';

import { WorkspaceFilesView } from '@/features/workspace/workspace-layout/workspace-files-view';

/**
 * /projects/[id]/files — the standalone Files page (Google-Drive-style browser
 * over the workspace repo). A regular routed page inside the workspace shell, NOT
 * a Customize section. Requires `project.file.read` (editor-tier): the sidebar
 * entry hides for floor members and the API 403s their reads (silently — the
 * view shows its own empty/error state, never a global toast).
 */
export default function WorkspaceFilesPage() {
  const { id: workspaceId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <WorkspaceFilesView workspaceId={workspaceId} />
      </div>
  );
}
