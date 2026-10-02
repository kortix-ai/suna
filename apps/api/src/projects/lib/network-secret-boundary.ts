import { eq } from 'drizzle-orm';
import { projectSessions, projects } from '@kortix/db';
import { isMetaAgentName } from '@kortix/shared';

import { db } from '../../shared/db';
import { resolveNetworkBoundaryBindings } from '../../secrets/network-boundary';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { intersectSecretGrants, listResolvedProjectSecrets } from '../secrets';
import { resolveSessionPersonalOwner } from './personal-resources';
import { secretAudienceSubject, type SecretAudienceSubject } from './secret-audience';
import { resolveSessionSecretGrant } from './secret-grant';

/**
 * What a session's sandbox may hold, before delivery: every value its subject
 * reaches, narrowed to the running agent's `secrets` grant and the session
 * allowlist. Shared by the network-boundary bindings and the share guard
 * (secret-audience.ts `sessionPersonOnlyPlaintextSecrets`).
 */
async function loadSessionSecretRows(
  projectId: string,
  sessionId: string,
  subject: SecretAudienceSubject | (() => Promise<SecretAudienceSubject>),
  requestedAgent?: string | null,
  /** `assume_all`: an unreadable grant counts as admitting every secret — the
   *  share guard's fail-closed reading. Default: the error propagates. */
  onGrantError: 'throw' | 'assume_all' = 'throw',
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
  if (!session || !project) return null;
  const sessionAgent = session.agentName ?? DEFAULT_AGENT_SENTINEL;
  if (isMetaAgentName(sessionAgent)) return null;

  const agentGrantEnv = await resolveSessionSecretGrant({
    projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath,
    sessionAgent,
    requestedAgent,
    forceRefresh: 'tip-proof',
  }).catch((error: unknown) => {
    if (onGrantError === 'assume_all') return 'all' as const;
    throw error;
  });
  // Spec 2026-09-22 §2.3: personal overrides follow the session's on-behalf-of
  // human under the agent-principal model; the creator otherwise (legacy).
  const personalUserId = await resolveSessionPersonalOwner({
    projectId,
    sessionId,
    legacyUserId: session.createdBy ?? null,
  });
  const rows = await listResolvedProjectSecrets(projectId, personalUserId, subject);
  return { rows, session, agentGrantEnv };
}

export async function resolveSessionNetworkBoundary(
  projectId: string,
  sessionId: string,
  requestedAgent?: string | null,
) {
  const loaded = await loadSessionSecretRows(
    projectId,
    sessionId,
    () => secretAudienceSubject({ projectId, sessionId }),
    requestedAgent,
  );
  if (!loaded) return [];
  return resolveNetworkBoundaryBindings(loaded.rows, {
    sessionId,
    agentGrantEnv: loaded.agentGrantEnv ?? null,
    sessionAllowlist: loaded.session.secretsAllowlist ?? null,
  });
}

/** The rows the session's grant and allowlist admit, resolved for `subject`. */
export async function listSessionDeliveredSecretRows(
  projectId: string,
  sessionId: string,
  subject: SecretAudienceSubject,
) {
  const loaded = await loadSessionSecretRows(projectId, sessionId, subject, null, 'assume_all');
  if (!loaded) return [];
  const admitted = intersectSecretGrants(loaded.agentGrantEnv, loaded.session.secretsAllowlist ?? null);
  if (admitted === undefined || admitted === 'all') return loaded.rows;
  const allowed = new Set(admitted.map((identifier) => identifier.toUpperCase()));
  return loaded.rows.filter((row) => allowed.has(row.identifier.toUpperCase()));
}
