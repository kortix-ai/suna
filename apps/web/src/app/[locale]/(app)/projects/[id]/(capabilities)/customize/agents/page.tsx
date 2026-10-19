'use client';

import { useParams } from 'next/navigation';

import { AgentsPage } from '@kortix/ui/customize';

/**
 * /projects/[id]/agent — the standalone Agents catalog. See
 * `packages/ui/src/customize/agents/agents-page.tsx` for the page body.
 */
export default function ProjectAgentPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AgentsPage projectId={projectId} />
    </div>
  );
}
