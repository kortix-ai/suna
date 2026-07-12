'use client';

import { TunnelOverview } from '@/features/tunnel/tunnel-overview';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

export function ComputersView({ projectId }: { projectId: string }) {
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;
  return <TunnelOverview canWrite={canWrite} />;
}
