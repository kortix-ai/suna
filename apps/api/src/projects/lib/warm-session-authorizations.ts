import { DEFAULT_AGENT_SENTINEL, loadProjectAgents, requiredConnectorsForAgent } from '../agents';
import type { GitBackedProject } from '../git/types';
import { missingRequiredConnectorAuthorizationsForSession } from './session-connector-bindings';

type WarmSessionAuthorizationProject = GitBackedProject & {
  accountId: string;
  projectId: string;
};

type WarmSessionAuthorizationTarget = {
  sessionId: string;
  agentName: string | null;
};

export async function loadRequiredConnectorsForWarmSession(
  project: GitBackedProject,
  session: Pick<WarmSessionAuthorizationTarget, 'agentName'>,
): Promise<string[]> {
  const loadedAgents = await loadProjectAgents(project, {
    forceRefresh: true,
    rethrowReadErrors: true,
  });
  return requiredConnectorsForAgent(session.agentName ?? DEFAULT_AGENT_SENTINEL, loadedAgents);
}

export async function missingWarmSessionAuthorizations(
  project: WarmSessionAuthorizationProject,
  session: WarmSessionAuthorizationTarget,
) {
  const required = await loadRequiredConnectorsForWarmSession(project, session);
  if (required.length === 0) return [];
  return missingRequiredConnectorAuthorizationsForSession({
    accountId: project.accountId,
    projectId: project.projectId,
    sessionId: session.sessionId,
    aliases: required,
  });
}
