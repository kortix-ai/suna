/**
 * Session asks: everything an agent waits on a person for, in one model.
 *
 * THE PROBLEM. A `question` call or a permission ask used to hold its tool call
 * until a person answered. The turn stayed active, so the prompt inbox refused
 * every queued message with `turn_active`: a peer session's message, a
 * subagent's report, a trigger fire, the person's own follow-up. One unanswered
 * ask stalled an autonomous flow for hours or days.
 *
 * THE MODEL. An ask never holds the session. The runtime waits for a live answer
 * for `liveWaitMsFor` (0 when nobody watches the session), then PARKS the ask:
 * the call returns, the turn goes on, and the ask stays open here until a person
 * answers it, dismisses it, or it expires. A message that waits behind a turn
 * parks the asks at once (`parkRuntimeAsks`). The answer reaches the agent as
 * a new message. A person sees every open ask in Review and as "Needs you" on
 * the session a person opens (`surface_session_id`).
 *
 * Three kinds share the model: a question (`session_pending_questions`), a
 * permission ask (`session_pending_permissions`) and a connector approval
 * (`connector_calls`, which never held a turn).
 */

import { connectorCalls, projectSessions, sessionPendingPermissions, sessionPendingQuestions } from '@kortix/db';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { isUnattendedSessionMetadata } from '../../channels/question-release';
import { db } from '../../shared/db';
import { isUnattendedSession } from '../session-lifecycle/unattended-runtime-recovery';

/** How long an ask holds its call while a person may be watching. Matches kortixd `DEFAULT_LIVE_WAIT_MS`. */
export const ASK_LIVE_WAIT_MS = 180_000;

/** A parked ask closes as expired after this. Matches the connector approval default (`approvals.ttl`). */
export const ASK_TTL_MS = 24 * 60 * 60 * 1000;

/** How far `surfaceSessionIdOf` walks up `parent_session_id`. */
const MAX_SURFACE_DEPTH = 8;

export type AskKind = 'question' | 'permission' | 'approval';

/** One open ask, as Review, the session and the "Needs you" state read it. */
export interface SessionAsk {
  /** `<kind>:<row id>`: the id `POST /asks/:askId/answer` takes. */
  id: string;
  kind: AskKind;
  /** The session whose call asked (a hidden worker, or the session itself). */
  session_id: string;
  /** The session a person opens for it. */
  surface_session_id: string;
  /** The runtime's request id (question, permission); the execution id (approval). */
  request_id: string;
  /** One line for a list row: the question header, the command, the connector action. */
  title: string;
  asked_at: string;
  expires_at: string | null;
  question?: { questions: unknown };
  permission?: { tool: string; permission: string; patterns: string[]; args: unknown };
  /** A connector call that waits for approval; it is decided over `/approvals/:executionId`. */
  approval?: { action: string };
}

/** The session row fields the ask policy reads. */
export interface AskSessionFacts {
  origin: string | null;
  metadata: unknown;
  parentSessionId: string | null;
}

/**
 * How long an ask holds its call for a live answer. 0 parks it at once: nobody
 * watches a trigger, schedule or system session, a session marked `unattended`,
 * or a worker another session started (its person watches the parent).
 */
export function liveWaitMsFor(session: AskSessionFacts): number {
  const metadata = session.metadata && typeof session.metadata === 'object' ? (session.metadata as Record<string, unknown>) : null;
  if (isUnattendedSessionMetadata(metadata)) return 0;
  if (session.parentSessionId) return 0;
  return isUnattendedSession({ origin: session.origin as never, metadata }) ? 0 : ASK_LIVE_WAIT_MS;
}

export function askExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + ASK_TTL_MS).toISOString();
}

/** The ask policy facts of one session. Null: no such session. */
export async function readAskSessionFacts(sessionId: string): Promise<AskSessionFacts | null> {
  const [row] = await db
    .select({ origin: projectSessions.origin, metadata: projectSessions.metadata, parentSessionId: projectSessions.parentSessionId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * The session a person opens for an ask of `sessionId`: walk `parent_session_id`
 * up to the root. A Spaces worker's root is its Router thread; a coordinator's
 * worker's root is the coordinator. The session itself when it has no parent.
 */
export async function surfaceSessionIdOf(sessionId: string, first?: AskSessionFacts | null): Promise<string> {
  let current = sessionId;
  let parent = first === undefined ? (await readAskSessionFacts(sessionId))?.parentSessionId ?? null : first?.parentSessionId ?? null;
  const seen = new Set([sessionId]);
  for (let depth = 0; parent && depth < MAX_SURFACE_DEPTH && !seen.has(parent); depth++) {
    seen.add(parent);
    current = parent;
    parent = (await readAskSessionFacts(parent))?.parentSessionId ?? null;
  }
  return current;
}

export const pendingAskNotExpired = (
  column: typeof sessionPendingQuestions.expiresAt | typeof sessionPendingPermissions.expiresAt | typeof connectorCalls.expiresAt,
) => or(isNull(column), gt(column, sql`NOW()`));

function questionTitle(questions: unknown): string {
  const first = Array.isArray(questions) ? (questions[0] as { header?: unknown; question?: unknown } | undefined) : undefined;
  const text = typeof first?.question === 'string' && first.question.trim() ? first.question : first?.header;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : 'The agent asks you a question';
}

export function permissionTitle(tool: string, patterns: unknown): string {
  const subject = Array.isArray(patterns) && typeof patterns[0] === 'string' && patterns[0] !== '*' ? patterns[0] : '';
  return (subject ? `${tool}: ${subject}` : `Run ${tool}`).slice(0, 200);
}

/**
 * Every open ask of a project, newest first: questions and permission asks
 * that are open and not expired, and connector calls that wait for approval.
 * `surfaceSessionId` keeps the asks a person opens on that session;
 * `sessionIds` keeps the asks of those sessions (a caller's visible set).
 */
export async function listOpenAsks(input: {
  projectId: string;
  surfaceSessionId?: string;
  sessionIds?: readonly string[];
  limit?: number;
}): Promise<SessionAsk[]> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  if (input.sessionIds && input.sessionIds.length === 0) return [];
  const qSurface = input.surfaceSessionId
    ? or(eq(sessionPendingQuestions.surfaceSessionId, input.surfaceSessionId), and(isNull(sessionPendingQuestions.surfaceSessionId), eq(sessionPendingQuestions.sessionId, input.surfaceSessionId)))
    : undefined;
  const pSurface = input.surfaceSessionId
    ? or(eq(sessionPendingPermissions.surfaceSessionId, input.surfaceSessionId), and(isNull(sessionPendingPermissions.surfaceSessionId), eq(sessionPendingPermissions.sessionId, input.surfaceSessionId)))
    : undefined;
  const [questions, permissions, approvals] = await Promise.all([
    db
      .select({
        id: sessionPendingQuestions.id,
        sessionId: sessionPendingQuestions.sessionId,
        surfaceSessionId: sessionPendingQuestions.surfaceSessionId,
        requestId: sessionPendingQuestions.requestId,
        questions: sessionPendingQuestions.questions,
        askedAt: sessionPendingQuestions.askedAt,
        expiresAt: sessionPendingQuestions.expiresAt,
      })
      .from(sessionPendingQuestions)
      .where(
        and(
          eq(sessionPendingQuestions.projectId, input.projectId),
          isNull(sessionPendingQuestions.answeredAt),
          pendingAskNotExpired(sessionPendingQuestions.expiresAt),
          qSurface,
          input.sessionIds ? inArray(sessionPendingQuestions.sessionId, [...input.sessionIds]) : undefined,
        ),
      )
      .orderBy(desc(sessionPendingQuestions.askedAt))
      .limit(limit),
    db
      .select({
        id: sessionPendingPermissions.id,
        sessionId: sessionPendingPermissions.sessionId,
        surfaceSessionId: sessionPendingPermissions.surfaceSessionId,
        requestId: sessionPendingPermissions.requestId,
        tool: sessionPendingPermissions.tool,
        permission: sessionPendingPermissions.permission,
        patterns: sessionPendingPermissions.patterns,
        args: sessionPendingPermissions.args,
        askedAt: sessionPendingPermissions.askedAt,
        expiresAt: sessionPendingPermissions.expiresAt,
      })
      .from(sessionPendingPermissions)
      .where(
        and(
          eq(sessionPendingPermissions.projectId, input.projectId),
          isNull(sessionPendingPermissions.decidedAt),
          pendingAskNotExpired(sessionPendingPermissions.expiresAt),
          pSurface,
          input.sessionIds ? inArray(sessionPendingPermissions.sessionId, [...input.sessionIds]) : undefined,
        ),
      )
      .orderBy(desc(sessionPendingPermissions.askedAt))
      .limit(limit),
    db
      .select({
        callId: connectorCalls.executionId,
        sessionId: connectorCalls.sessionId,
        action: connectorCalls.actionPath,
        createdAt: connectorCalls.createdAt,
        expiresAt: connectorCalls.expiresAt,
      })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.projectId, input.projectId),
          eq(connectorCalls.status, 'pending_approval'),
          pendingAskNotExpired(connectorCalls.expiresAt),
          input.sessionIds ? inArray(connectorCalls.sessionId, [...input.sessionIds]) : undefined,
        ),
      )
      .orderBy(desc(connectorCalls.createdAt))
      .limit(limit),
  ]);

  // A connector call records only its own session: resolve the surface here.
  const approvalSurfaces = new Map<string, string>();
  for (const sessionId of new Set(approvals.map((a) => a.sessionId).filter((s): s is string => !!s))) {
    approvalSurfaces.set(sessionId, await surfaceSessionIdOf(sessionId));
  }

  const asks: SessionAsk[] = [
    ...questions.map((q): SessionAsk => ({
      id: `question:${q.id}`,
      kind: 'question',
      session_id: q.sessionId,
      surface_session_id: q.surfaceSessionId ?? q.sessionId,
      request_id: q.requestId,
      title: questionTitle(q.questions),
      asked_at: q.askedAt,
      expires_at: q.expiresAt,
      question: { questions: q.questions },
    })),
    ...permissions.map((p): SessionAsk => ({
      id: `permission:${p.id}`,
      kind: 'permission',
      session_id: p.sessionId,
      surface_session_id: p.surfaceSessionId ?? p.sessionId,
      request_id: p.requestId,
      title: permissionTitle(p.tool, p.patterns),
      asked_at: p.askedAt,
      expires_at: p.expiresAt,
      permission: { tool: p.tool, permission: p.permission, patterns: Array.isArray(p.patterns) ? (p.patterns as string[]) : [], args: p.args },
    })),
    ...approvals
      .filter((a) => !!a.sessionId)
      .map((a): SessionAsk => ({
        id: `approval:${a.callId}`,
        kind: 'approval',
        session_id: a.sessionId!,
        surface_session_id: approvalSurfaces.get(a.sessionId!) ?? a.sessionId!,
        request_id: a.callId,
        title: a.action.slice(0, 200),
        asked_at: toIso(a.createdAt),
        expires_at: a.expiresAt ? toIso(a.expiresAt) : null,
        approval: { action: a.action },
      })),
  ].filter((ask) => !input.surfaceSessionId || ask.surface_session_id === input.surfaceSessionId);
  asks.sort((a, b) => (a.asked_at < b.asked_at ? 1 : a.asked_at > b.asked_at ? -1 : 0));
  return asks.slice(0, limit);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Parse `<kind>:<id>`. Null: not an ask id. */
export function parseAskId(askId: string): { kind: AskKind; id: string } | null {
  const match = /^(question|permission|approval):([A-Za-z0-9_-]{1,128})$/.exec(askId);
  return match ? { kind: match[1] as AskKind, id: match[2]! } : null;
}

/** Does this session have an ask that may still hold its call live (asked within the live window)? */
export async function sessionHasLiveAsk(sessionId: string): Promise<boolean> {
  const since = sql`NOW() - (${ASK_LIVE_WAIT_MS} * interval '1 millisecond')`;
  const [question] = await db
    .select({ id: sessionPendingQuestions.id })
    .from(sessionPendingQuestions)
    .where(and(eq(sessionPendingQuestions.sessionId, sessionId), isNull(sessionPendingQuestions.answeredAt), gt(sessionPendingQuestions.askedAt, since)))
    .limit(1);
  if (question) return true;
  const [permission] = await db
    .select({ id: sessionPendingPermissions.id })
    .from(sessionPendingPermissions)
    .where(and(eq(sessionPendingPermissions.sessionId, sessionId), isNull(sessionPendingPermissions.decidedAt), gt(sessionPendingPermissions.askedAt, since)))
    .limit(1);
  return !!permission;
}
