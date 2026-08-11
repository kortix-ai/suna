import { eq } from 'drizzle-orm';
import { projectSessions, projects } from '@kortix/db';
import { isMetaAgentName } from '@kortix/shared';

import { db } from '../../shared/db';
import { resolveNetworkBoundaryBindings } from '../../secrets/network-boundary';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { listResolvedWorkspaceSecrets } from '../secrets';
import { resolveSessionSecretGrant } from './secret-grant';

export async function resolveSessionNetworkBoundary(
  workspaceId: string,
  sessionId: string,
  requestedAgent?: string | null,
) {
  const [session, workspace] = await Promise.all([
    db
      .select({
        createdBy: projectSessions.createdBy,
        agentName: projectSessions.agentName,
        secretsAllowlist: projectSessions.secretsAllowlist,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        manifestPath: projects.manifestPath,
      })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (!session || !workspace) return [];
  const sessionAgent = session.agentName ?? DEFAULT_AGENT_SENTINEL;
  if (isMetaAgentName(sessionAgent)) return [];

  const agentGrantEnv = await resolveSessionSecretGrant({
    workspaceId,
    repoUrl: workspace.repoUrl,
    defaultBranch: workspace.defaultBranch,
    manifestPath: workspace.manifestPath,
    sessionAgent,
    requestedAgent,
  });
  const rows = await listResolvedWorkspaceSecrets(workspaceId, session.createdBy ?? null);
  return resolveNetworkBoundaryBindings(rows, {
    sessionId,
    agentGrantEnv: agentGrantEnv ?? null,
    sessionAllowlist: session.secretsAllowlist ?? null,
  });
}
