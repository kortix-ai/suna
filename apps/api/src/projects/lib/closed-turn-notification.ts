// A turn the control plane closed notifies like a relay-closed one: turn
// recovery on a turn read and inbox admission
// (session-lifecycle/inbox-turn-recovery.ts), and the reaper
// (reaping/box-reaper.ts). The relay's late `end` then gets `already_closed`
// and sends nothing, so without this the person who prompted the turn is
// never told (KRTX-2041). Only the caller whose close won may call it.
import { projectSessions, sessionTurns } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import {
  closedTurnPushType,
  notifySessionEvent,
  type SessionPushEvent,
  type SessionPushOutcome,
} from '../../notifications/session-push';
import { db } from '../../shared/db';
import type { SessionTurnEndReason } from '../session-turn-ledger';
import { turnEndNotificationContext, type NotificationSessionRef } from './notification-recipients';

export interface ClosedTurnSession extends NotificationSessionRef {
  childSession: boolean;
  /** The closed turns' `session_turns.end_error` names. */
  endErrorNames: (string | null)[];
  /** The newest closed turn's prompt message id: its prompter and dedupe key. */
  turnMessageId: string | null;
  /** The newest closed turn's error message, for an `error` notification. */
  errorMessage: string | null;
}

export interface ClosedTurnNotifyDeps {
  loadSession(sessionId: string, turnTokens: readonly string[]): Promise<ClosedTurnSession | null>;
  context: typeof turnEndNotificationContext;
  notify(event: SessionPushEvent): Promise<SessionPushOutcome>;
}

/** The session row and the closed turns (`session_turns` is keyed by turn token). */
async function loadClosedTurnSession(sessionId: string, turnTokens: readonly string[]): Promise<ClosedTurnSession | null> {
  const [row] = await db
    .select({
      projectId: projectSessions.projectId,
      accountId: projectSessions.accountId,
      metadata: projectSessions.metadata,
      origin: projectSessions.origin,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  const turns = turnTokens.length === 0 ? [] : await db
    .select({ endError: sessionTurns.endError, messageId: sessionTurns.messageId })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), inArray(sessionTurns.turnToken, [...turnTokens])))
    .orderBy(desc(sessionTurns.startedAt));
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    sessionId,
    ...row,
    childSession: typeof meta.spawned_by_session === 'string',
    endErrorNames: turns.map((turn) => turn.endError?.name ?? null),
    turnMessageId: turns.find((turn) => turn.messageId)?.messageId ?? null,
    errorMessage: turns.find((turn) => turn.endError?.message)?.endError?.message ?? null,
  };
}

/**
 * Notify for a turn this caller closed (see `closedTurnPushType`). Pass the
 * closed turns' tokens: a requested stop stays silent, and the turn's message
 * id names its prompter. Never throws.
 */
export async function notifyClosedTurn(
  input: { sessionId: string; reason: SessionTurnEndReason; promoted?: boolean; turnTokens?: readonly string[] },
  deps: ClosedTurnNotifyDeps = {
    loadSession: loadClosedTurnSession,
    context: turnEndNotificationContext,
    notify: notifySessionEvent,
  },
): Promise<void> {
  if (!closedTurnPushType(input)) return;
  try {
    const session = await deps.loadSession(input.sessionId, input.turnTokens ?? []);
    const type = session && closedTurnPushType({
      ...input,
      childSession: session.childSession,
      endErrorNames: session.endErrorNames,
    });
    if (!session || !type) return;
    const context = await deps.context(session, session.turnMessageId);
    await deps.notify({
      type,
      sessionId: input.sessionId,
      projectId: session.projectId,
      turnMessageId: session.turnMessageId,
      errorMessage: type === 'error' ? session.errorMessage : null,
      ...context,
    });
  } catch (err) {
    logger.warn('[notify] closed-turn notification failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
