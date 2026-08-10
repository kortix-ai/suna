'use client';

import { TunnelOverview } from '@/features/tunnel/tunnel-overview';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';

export function ComputersView({ workspaceId }: { workspaceId: string }) {
  const canWrite =
    useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE).allowed === true;
  return <TunnelOverview canWrite={canWrite} />;
}
