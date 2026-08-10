import { DEFAULT_AGENT_SENTINEL, loadWorkspaceAgents, requiredConnectorsForAgent } from '../agents';
import type { GitBackedWorkspace } from '../git/types';
import { missingRequiredConnectorConnectionsForSession } from './session-connector-bindings';

type WarmSessionAuthorizationWorkspace = GitBackedWorkspace & {
  accountId: string;
  workspaceId: string;
};

type WarmSessionAuthorizationTarget = {
  sessionId: string;
  agentName: string | null;
};

export async function loadRequiredConnectorsForWarmSession(
  workspace: GitBackedWorkspace,
  session: Pick<WarmSessionAuthorizationTarget, 'agentName'>,
): Promise<string[]> {
  const loadedAgents = await loadWorkspaceAgents(workspace, {
    forceRefresh: true,
    rethrowReadErrors: true,
  });
  return requiredConnectorsForAgent(session.agentName ?? DEFAULT_AGENT_SENTINEL, loadedAgents);
}

export async function missingWarmSessionConnections(
  workspace: WarmSessionAuthorizationWorkspace,
  session: WarmSessionAuthorizationTarget,
) {
  const required = await loadRequiredConnectorsForWarmSession(workspace, session);
  if (required.length === 0) return [];
  return missingRequiredConnectorConnectionsForSession({
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: session.sessionId,
    aliases: required,
  });
}
