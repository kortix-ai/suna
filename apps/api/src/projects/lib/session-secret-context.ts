import { eq } from 'drizzle-orm';
import { projectSessions, projects } from '@kortix/db';

import { db } from '../../lib/db';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionPersonalOwner } from './personal-resources';
import { resolveSessionSecretGrant } from './secret-grant';

/**
 * What decides a session's secret delivery, read once.
 *
 * A prompt's env sync resolves the env snapshot and the network-boundary
 * bindings. Each read the session row, the project row, the running agent's
 * `secrets` grant and the personal-override owner for itself: 8 statements and
 * 2 manifest reads where 4 and 1 answer both. They take one context instead.
 *
 * `grantEnv` and `personalUserId` are lazy and memoized. `grantEnv` rejects
 * with `SecretGrantResolutionError` on an unreadable manifest (fail closed),
 * for every caller that awaits it.
 */
export interface SessionSecretContext {
  session: { createdBy: string | null; agentName: string | null; secretsAllowlist: string[] | null } | undefined;
  project: { repoUrl: string | null; defaultBranch: string | null; manifestPath: string | null } | undefined;
  grantEnv: () => Promise<string[] | 'all' | undefined>;
  personalUserId: () => Promise<string | null>;
}

export async function loadSessionSecretContext(
  projectId: string,
  sessionId: string,
  requestedAgent?: string | null,
): Promise<SessionSecretContext> {
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
  let grantEnv: Promise<string[] | 'all' | undefined> | undefined;
  let personalUserId: Promise<string | null> | undefined;
  return {
    session,
    project,
    grantEnv: () =>
      (grantEnv ??= resolveSessionSecretGrant({
        projectId,
        repoUrl: project?.repoUrl ?? '',
        defaultBranch: project?.defaultBranch,
        manifestPath: project?.manifestPath,
        sessionAgent: session?.agentName ?? DEFAULT_AGENT_SENTINEL,
        requestedAgent,
        forceRefresh: 'tip-proof',
      })),
    // Spec 2026-09-22 §2.3: personal overrides follow the session's
    // on-behalf-of human under the agent-principal model; the creator otherwise.
    personalUserId: () =>
      (personalUserId ??= resolveSessionPersonalOwner({
        projectId,
        sessionId,
        legacyUserId: session?.createdBy ?? null,
      })),
  };
}
