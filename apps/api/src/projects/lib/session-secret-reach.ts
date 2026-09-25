/**
 * Which secret NAMES a session will never receive, and why.
 *
 * A runtime secret reaches a sandbox only when the running agent's `secrets`
 * grant AND the session's `secrets_allowlist` both admit its identifier
 * (sandbox-env-sync.ts intersects the two). A stored value outside either is
 * withheld silently: the agent finds no env var, reports the secret as unset,
 * and the human re-enters a value that was saved the first time (prod
 * 2026-09-25: two secrets set through the intake link AND the Secrets page, a
 * reload, and the session still saw nothing — the agent's grant excluded them).
 *
 * This module names that case so every surface can say it. It answers only for
 * names the caller already holds (the ones it requested or just submitted), so
 * it never widens what an agent can enumerate — the verdict comes from the
 * grant, not from which secrets exist.
 */
import { projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionSecretGrant } from './secret-grant';

export type SecretWithheldReason = 'agent_grant' | 'session_allowlist';

export interface WithheldSecret {
  name: string;
  reason: SecretWithheldReason;
}

export interface SessionSecretReach {
  /** The agent the session is bound to (`project_sessions.agent_name`). */
  agent: string;
  grantEnv: string[] | 'all' | undefined;
  allowlist: string[] | null;
}

function admits(list: string[], name: string): boolean {
  const target = name.toUpperCase();
  return list.some((entry) => entry.toUpperCase() === target);
}

/**
 * The names in `names` that a session with this grant and allowlist never
 * receives. The agent grant is reported first: it is the durable setting a
 * human can change, while an allowlist is fixed for the life of the session.
 * Pure.
 */
export function withheldSecrets(
  names: string[],
  grantEnv: string[] | 'all' | undefined,
  allowlist: string[] | null | undefined,
): WithheldSecret[] {
  const withheld: WithheldSecret[] = [];
  for (const name of names) {
    if (grantEnv !== undefined && grantEnv !== 'all' && !admits(grantEnv, name)) {
      withheld.push({ name, reason: 'agent_grant' });
    } else if (allowlist != null && !admits(allowlist, name)) {
      withheld.push({ name, reason: 'session_allowlist' });
    }
  }
  return withheld;
}

/**
 * Resolve the grant and allowlist a session's secret delivery uses, through the
 * same resolver as boot and the hot push. Returns null when the session or its
 * project is gone. Throws `SecretGrantResolutionError` on an unreadable
 * manifest; advisory callers catch it and say nothing rather than guess.
 */
export async function resolveSessionSecretReach(
  sessionId: string,
): Promise<SessionSecretReach | null> {
  const [session] = await db
    .select({
      projectId: projectSessions.projectId,
      agentName: projectSessions.agentName,
      secretsAllowlist: projectSessions.secretsAllowlist,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session) return null;
  const [project] = await db
    .select({
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, session.projectId))
    .limit(1);
  if (!project) return null;
  const agent = session.agentName ?? DEFAULT_AGENT_SENTINEL;
  const grantEnv = await resolveSessionSecretGrant({
    projectId: session.projectId,
    repoUrl: project.repoUrl ?? '',
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath,
    sessionAgent: agent,
    // The human may have just changed the grant in Customize; read it fresh.
    forceRefresh: true,
  });
  return { agent, grantEnv, allowlist: session.secretsAllowlist ?? null };
}

export interface SessionWithheldSecrets {
  agent: string;
  withheld: WithheldSecret[];
}

/**
 * Which of `names` a session will never receive. Advisory: an unreadable grant
 * says nothing rather than guess, because every caller has already done (or is
 * about to do) the real work — saving a value or minting a link. Null when
 * nothing is withheld.
 */
export async function sessionWithheldSecrets(
  sessionId: string,
  names: string[],
): Promise<SessionWithheldSecrets | null> {
  try {
    const reach = await resolveSessionSecretReach(sessionId);
    if (!reach) return null;
    const withheld = withheldSecrets(names, reach.grantEnv, reach.allowlist);
    return withheld.length > 0 ? { agent: reach.agent, withheld } : null;
  } catch (err) {
    console.warn('[secrets] could not resolve the session secret grant:', err);
    return null;
  }
}

/**
 * The agent-facing fix for each withheld name, as one sentence per reason.
 * Shared by the intake notification, the mint response and the CLI so the
 * wording never drifts between surfaces.
 */
export function withheldSecretsFix(agent: string, withheld: WithheldSecret[]): string {
  const byGrant = withheld.filter((w) => w.reason === 'agent_grant').map((w) => w.name);
  const byAllowlist = withheld.filter((w) => w.reason === 'session_allowlist').map((w) => w.name);
  const parts: string[] = [];
  if (byGrant.length > 0) {
    const grantCommand =
      byGrant.length === 1 ? `kortix secrets grant ${byGrant[0]} --agent ${agent}` : `kortix secrets grant <NAME> --agent ${agent}`;
    parts.push(
      `${byGrant.join(', ')} ${byGrant.length === 1 ? 'is' : 'are'} not in agent "${agent}"'s secrets grant, ` +
        'so this session never receives the value, even when it is set. ' +
        'An agent session cannot widen its own grant; a person with project access must. ' +
        `Fix: in the web app open Customize → Agents → ${agent} → Secrets and enable ` +
        `${byGrant.length === 1 ? 'it' : 'them'} (or, from their own CLI: \`${grantCommand}\`). ` +
        'Kortix pushes the change to this session when it is saved, and the next message re-syncs ' +
        'it regardless; agent sessions cannot run `kortix secrets sync`.',
    );
  }
  if (byAllowlist.length > 0) {
    parts.push(
      `${byAllowlist.join(', ')} ${byAllowlist.length === 1 ? 'is' : 'are'} outside this session's secrets allowlist, ` +
        'which is fixed when the session is created. Fix: start a new session that includes ' +
        `${byAllowlist.length === 1 ? 'it' : 'them'}.`,
    );
  }
  return parts.join(' ');
}
