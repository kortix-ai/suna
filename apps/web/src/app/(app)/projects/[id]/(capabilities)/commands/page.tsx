'use client';

import { useParams } from 'next/navigation';

import { CapabilityRouteGate } from '@/features/workspace/capabilities/shared/capability-route-gate';

import { CommandsPage } from '@/features/workspace/capabilities/commands/commands-page';

/**
 * /projects/[id]/commands — the standalone Commands catalog. See
 * `features/workspace/capabilities/commands/commands-page.tsx` for the page
 * body.
 */
export default function ProjectCommandsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <CapabilityRouteGate projectId={projectId} section="commands">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CommandsPage projectId={projectId} />
      </div>
    </CapabilityRouteGate>
  );
}
