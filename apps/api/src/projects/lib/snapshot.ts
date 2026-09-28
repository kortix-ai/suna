import { eq } from 'drizzle-orm';
import { projects, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { intersectSecretGrants, listProjectSecretsSnapshotForUser, projectSecretsRevision } from '../secrets';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionSecretGrant } from './secret-grant';
import { sanitizeSandboxEnv } from './sandbox-env-names';
import { resolveSessionPersonalOwner } from './personal-resources';

export interface SandboxEnvSnapshot {
  env: Record<string, string>;
  names: string[];
  revision: string;
  scope: 'inherit' | 'restricted' | 'none';
  capabilitiesJson: string;
}

async function resolveOwnerRawEnv(
  projectId: string,
  sessionId: string | null,
  requestedAgent?: string | null,
): Promise<{
  env: Record<string, string>;
  capabilitiesJson: string;
  scope: SandboxEnvSnapshot['scope'];
} | null> {
  if (!sessionId) return null;
  const projectRead = Promise.resolve(
    db.select({
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    }).from(projects).where(eq(projects.projectId, projectId)).limit(1),
  );
  projectRead.catch(() => undefined);
  const [row] = await db.select({
    createdBy: projectSessions.createdBy,
    agentName: projectSessions.agentName,
    secretsAllowlist: projectSessions.secretsAllowlist,
  }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  if (!row?.createdBy) return null;

  const [project] = await projectRead;
  const grantEnv = await resolveSessionSecretGrant({
    projectId,
    repoUrl: project?.repoUrl ?? '',
    defaultBranch: project?.defaultBranch,
    manifestPath: project?.manifestPath,
    sessionAgent: row.agentName ?? DEFAULT_AGENT_SENTINEL,
    requestedAgent,
  });
  const grantEnvForSession = intersectSecretGrants(grantEnv, row.secretsAllowlist ?? null);
  const personalUserId = await resolveSessionPersonalOwner({
    projectId,
    sessionId,
    legacyUserId: row.createdBy,
  });
  const snapshot = await listProjectSecretsSnapshotForUser(
    projectId, personalUserId, grantEnvForSession, sessionId,
  );
  return {
    env: snapshot.env,
    capabilitiesJson: snapshot.capabilitiesJson,
    scope: row.secretsAllowlist == null
      ? 'inherit'
      : row.secretsAllowlist.length === 0 ? 'none' : 'restricted',
  };
}

export async function resolveSandboxEnvSnapshot(
  projectId: string,
  sessionId: string | null,
  requestedAgent?: string | null,
): Promise<SandboxEnvSnapshot | null> {
  const resolved = await resolveOwnerRawEnv(projectId, sessionId, requestedAgent);
  if (!resolved) return null;
  const { env, names } = sanitizeSandboxEnv(resolved.env);
  return {
    env,
    names,
    revision: projectSecretsRevision(env),
    capabilitiesJson: resolved.capabilitiesJson,
    scope: resolved.scope,
  };
}
