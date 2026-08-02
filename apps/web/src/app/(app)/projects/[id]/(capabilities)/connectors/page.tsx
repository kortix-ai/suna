'use client';

import { useParams } from 'next/navigation';

import { ConnectorsPage } from '@/features/workspace/capabilities/connectors/connectors-page';

/**
 * /projects/[id]/connectors — the standalone Connectors catalog. See
 * `features/workspace/capabilities/connectors/connectors-page.tsx` for the
 * page body.
 */
export default function ProjectConnectorsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ConnectorsPage projectId={projectId} />
    </div>
  );
}
