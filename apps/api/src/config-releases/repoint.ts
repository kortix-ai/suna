/**
 * THE ONE WRITER of `project_sessions.agent_name` after create, and the IAM
 * question that gates it.
 *
 * Nothing else in the API has ever updated that column. Two modules assert it
 * in prose — `projects/lib/secret-grant.ts` ("a column nothing ever updates")
 * and `projects/lib/session-token-grant.ts:395` ("the create-time agent and
 * nothing ever updates it"). Both stay true in spirit: the column is still the
 * agent the session IS, and the only thing that moves it is the manifest
 * dropping the agent it named. `repointSessionAgentToDeclaredDefault` below is
 * that one writer, called from exactly one production site:
 * `config-releases/routes.ts`, on the daemon's own descriptor request
 * (`recordAssignment`), i.e. once per boot/converge. It is idempotent: after
 * the write the manifest declares the column's name and the decision resolves
 * to `declared`, so no later request writes again.
 *
 * The IAM question is asked about the SESSION'S OWNER, not the caller. The
 * caller on that path is the sandbox's own credential, which carries no IAM
 * identity by construction (`Credential.kind === 'sandbox'`). Re-pointing is a
 * permanent change to what the owner's session runs, so it clears the same
 * deny-by-default agent gate `resolveAndAuthorizeAgent` applies to a launch.
 */

import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { actorForUser } from '../iam/actor';
import { filterAccessibleObjects } from '../iam/authorize';
import { logger } from '../lib/logger';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';

export interface RepointSubject {
  projectId: string;
  accountId: string;
  sessionId: string;
  /** `project_sessions.created_by`. Null for a backend/service-origin session. */
  ownerUserId: string | null;
}

/**
 * May this session's owner run `agentName`?
 *
 * The same fold the composer's agent list and `resolveAndAuthorizeAgent` use,
 * so what the picker offers, what a launch accepts and what a re-point may
 * move a session onto cannot drift.
 *
 * A session with no owner user id is not a member-tier principal at all — it
 * was created by a service account or a backend key acting for the account,
 * which the fold passes through unfiltered anyway. Answer `true` rather than
 * inventing a denial from a missing column.
 */
export async function ownerMayUseAgent(subject: RepointSubject, agentName: string): Promise<boolean> {
  if (!subject.ownerUserId) return true;
  const actor = actorForUser(subject.ownerUserId, subject.accountId);
  const accessible = await filterAccessibleObjects(actor, subject.projectId, 'agent', [agentName]);
  return accessible.includes(agentName);
}

/**
 * Move the session onto `to`, once, with an audit row.
 *
 * Returns true when the column now says `to` — including when a concurrent
 * request already wrote it. The `WHERE agent_name = from` predicate is what
 * makes a second writer a no-op instead of a second audit row.
 */
export async function repointSessionAgentToDeclaredDefault(
  subject: RepointSubject,
  from: string,
  to: string,
): Promise<boolean> {
  let updated: { sessionId: string }[];
  try {
    updated = await db
      .update(projectSessions)
      .set({ agentName: to })
      .where(and(eq(projectSessions.sessionId, subject.sessionId), eq(projectSessions.agentName, from)))
      .returning({ sessionId: projectSessions.sessionId });
  } catch (error) {
    logger.warn('[config-releases] agent re-point write failed', {
      session_id: subject.sessionId,
      from,
      to,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (updated.length === 0) return false;

  await recordAuditEvent({
    accountId: subject.accountId,
    projectId: subject.projectId,
    sessionId: subject.sessionId,
    actorUserId: subject.ownerUserId,
    actorType: 'system',
    action: 'SESSION_AGENT_REPOINTED',
    resourceType: 'project_session',
    resourceId: subject.sessionId,
    outcome: 'success',
    agentName: to,
    before: { agent_name: from },
    after: { agent_name: to },
    metadata: {
      reason: 'the project manifest no longer declares the session agent',
      declared_default_agent: to,
    },
  }).catch((error: Error) =>
    logger.warn('[config-releases] agent re-point audit failed', {
      session_id: subject.sessionId,
      error: error.message,
    }),
  );
  return true;
}
