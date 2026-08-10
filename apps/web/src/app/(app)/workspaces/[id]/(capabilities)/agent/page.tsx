'use client';

import { useParams } from 'next/navigation';

import { AgentsPage } from '@/features/workspace/capabilities/agents/agents-page';

/**
 * /projects/[id]/agent — the standalone Agents catalog. See
 * `features/workspace/capabilities/agents/agents-page.tsx` for the page body.
 */
export default function WorkspaceAgentPage() {
  const { id: workspaceId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AgentsPage workspaceId={workspaceId} />
    </div>
  );
}
