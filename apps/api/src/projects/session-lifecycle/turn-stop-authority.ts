/**
 * WHO MAY STOP A RUNNING TURN: the person who prompted it, the session owner,
 * or a project manager.
 *
 * In a shared session any member who could send could also stop another
 * member's run, and the run then read "stopped" to its prompter with no name.
 * The rule is the one the session already applies elsewhere: steering a turn
 * is the prompter's (`inbox-admission.ts` `not_prompter`), and stopping the
 * computer is the owner's or a manager's (`POST .../stop`). Every path that
 * ends a running turn on a person's behalf asks this module: the hold route,
 * the sandbox-proxy abort, "Stop and send", the Quick Queue interrupt, and the
 * Slack and Teams Stop buttons. One answer, every surface.
 *
 * With no running turn there is nothing to stop: a hold then only pauses the
 * queue, which any member who may send may do.
 */
import { projectSessions, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { isTriggerRunSession } from '../../connectors/share';
import { actorForUser } from '../../iam/actor';
import { authorize } from '../../iam/authorize';
import { db } from '../../shared/db';
import { effectiveProjectRole, roleAllows, type AccountRole } from '../access';
import { getProjectMemberRole } from '../lib/project-access';
import { getAccountMembership } from '../lib/user-identity';
import { storedSandboxTurns } from '../session-turn-ledger';
import { newestStoredTurn, sessionHoldsTurnAuthority } from './inbox-admission';
import { wireMessageIdMatches } from './wire-id-match';

import { decideTurnStop, type TurnStopVerdict } from '../../shared/turn-stop-refusal';

/** The 403 `code` and copy every refused stop answers with, and the pure rule. */
export { decideTurnStop, NOT_TURN_PROMPTER, NOT_TURN_PROMPTER_MESSAGE, type TurnStopVerdict } from '../../shared/turn-stop-refusal';

/**
 * The person whose prompt started the turn behind `messageId`: an inbox row a
 * person sent (`bindTurnIdentity`), not one an agent session wrote. Null for a
 * trigger, a reminder, an agent prompt, or a turn whose prompt is unknown —
 * then only the owner or a manager may stop it.
 */
export async function turnPrompterOf(sessionId: string, messageId: string | null | undefined): Promise<string | null> {
  if (!messageId) return null;
  const [row] = await db
    .select({ actorUserId: sessionLifecycleCommands.actorUserId, payload: sessionLifecycleCommands.payload })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        wireMessageIdMatches(messageId),
      ),
    )
    .orderBy(desc(sessionLifecycleCommands.createdAt))
    .limit(1);
  const payload = (row?.payload ?? {}) as Record<string, unknown>;
  if (!row?.actorUserId || payload.bindTurnIdentity !== true || payload.authorSessionId != null) return null;
  return row.actorUserId;
}

/**
 * The newest running turn of a session, or null when nothing runs. The same
 * authority `GET .../turn` and admission read: a box that is not running holds
 * no turn, whatever its metadata still says.
 */
export async function readRunningTurn(sessionId: string): Promise<{ messageId: string | null } | null> {
  const [box] = await db
    .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!box || !sessionHoldsTurnAuthority(box)) return null;
  const turn = newestStoredTurn(storedSandboxTurns(box.metadata));
  return turn ? { messageId: turn.messageId ?? null } : null;
}

/** May this caller stop the session's running turn right now? */
export async function mayStopRunningTurn(input: {
  sessionId: string;
  callerUserId: string | null;
  canManageLifecycle: boolean;
  /** The running turn when the caller already read it, null when nothing runs. Omitted: read here. */
  running?: { messageId: string | null } | null;
}): Promise<TurnStopVerdict> {
  if (input.canManageLifecycle) return { allowed: true };
  const running = input.running === undefined ? await readRunningTurn(input.sessionId) : input.running;
  if (!running) return { allowed: true };
  const prompterUserId = await turnPrompterOf(input.sessionId, running.messageId);
  return decideTurnStop({ ...input, running: true, prompterUserId });
}

/**
 * `can_stop` for a turn read the caller already holds (`GET .../turn`, the
 * session-open bundle): its first turn is the newest. No second box read.
 */
export async function canStopTurns(
  state: { turns: ReadonlyArray<{ message_id: string | null }> },
  input: { sessionId: string; callerUserId: string | null; canManageLifecycle: boolean },
): Promise<boolean> {
  const newest = state.turns[0];
  const verdict = await mayStopRunningTurn({ ...input, running: newest ? { messageId: newest.message_id } : null });
  return verdict.allowed;
}

/**
 * Owner or manager standing for a human caller outside a Hono request: the
 * sandbox proxy and the Slack/Teams Stop buttons. Mirrors `loadVisibleSession`'s
 * `canManageLifecycle` for an unbound credential: the session's creator, a
 * project manager (an account owner or admin is one), and on a trigger's run
 * whoever may change the trigger (`project.trigger.update`).
 */
export async function sessionLifecycleStandingFor(input: {
  userId: string;
  accountId: string;
  projectId: string;
  sessionId: string;
}): Promise<boolean> {
  const [session] = await db
    .select({
      createdBy: projectSessions.createdBy,
      metadata: projectSessions.metadata,
      initiatorType: projectSessions.initiatorType,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  if (!session) return false;
  if (session.createdBy === input.userId) return true;
  const [membership, projectRole] = await Promise.all([
    getAccountMembership(input.userId, input.accountId),
    getProjectMemberRole(input.projectId, input.userId),
  ]);
  const role = membership ? effectiveProjectRole(membership.accountRole as AccountRole, projectRole) : projectRole;
  if (roleAllows(role, 'manage')) return true;
  if (!isTriggerRunSession(session)) return false;
  const verdict = await authorize(actorForUser(input.userId, input.accountId), 'project.trigger.update', {
    type: 'project',
    id: input.projectId,
  });
  return verdict.allowed;
}
