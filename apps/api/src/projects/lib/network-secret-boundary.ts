import { eq } from 'drizzle-orm';
import { projectSessions, projects } from '@kortix/db';
import { isMetaAgentName } from '@kortix/shared';

import { db } from '../../shared/db';
import { resolveNetworkBoundaryBindings } from '../../secrets/network-boundary';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { listResolvedProjectSecrets } from '../secrets';
import { resolveSessionSecretGrant } from './secret-grant';

export async function resolveSessionNetworkBoundary(
  projectId: string,
  sessionId: string,
  requestedAgent?: string | null,
) {
  const [session, project] = await Promise.all([
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
      .where(eq(projects.projectId, projectId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (!session || !project) return [];
  const sessionAgent = session.agentName ?? DEFAULT_AGENT_SENTINEL;
  if (isMetaAgentName(sessionAgent)) return [];

  const agentGrantEnv = await resolveSessionSecretGrant({
    projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath,
    sessionAgent,
    requestedAgent,
  });
  const rows = await listResolvedProjectSecrets(projectId, session.createdBy ?? null);
  return resolveNetworkBoundaryBindings(rows, {
    sessionId,
    agentGrantEnv: agentGrantEnv ?? null,
    sessionAllowlist: session.secretsAllowlist ?? null,
  });
}
