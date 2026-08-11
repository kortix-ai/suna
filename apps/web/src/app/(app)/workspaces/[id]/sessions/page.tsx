'use client';

import { WorkspaceSessionsView } from '@/features/workspace/workspace-sessions/workspace-sessions-view';
import { useParams } from 'next/navigation';

export default function WorkspaceSessionsPage() {
  const { id: workspaceId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WorkspaceSessionsView workspaceId={workspaceId} />
    </div>
  );
}
