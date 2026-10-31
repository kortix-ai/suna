/**
 * The prompts a session's runtime accepted that its log does not hold yet.
 *
 * A prompt leaves the inbox (`listInboxPrompts`) when a turn consumes it, and enters the
 * session log when the box journals it: pi posts every 5 s while a turn runs, and at the
 * turn end. A client that missed the live frame (its runtime connection opened after the
 * prompt was admitted: it is live-only) found the prompt in neither place, and drew the
 * session without the user's message until the turn ended. The `initial_prompt` of a
 * session create was never an inbox row, so it was missing from the moment of the create.
 *
 * `listSentPrompts` is that window: every accepted inbox prompt of the last
 * `SENT_WINDOW_MS`, and the `initial_prompt`, whose message id the log does not hold
 * (a tombstone counts as held). Each carries the id the log will hold it under, so a client
 * replaces it by id, never by text or position.
 */
import type { SessionSentPrompt } from '@kortix/api-contract';
import { projectSessions, sessionLifecycleCommands, sessionLogMessages, sessionSandboxes, sessionTurns } from '@kortix/db';
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { serializePrompt } from '../lib/session-prompt-view';
import { inboxScope } from './inbox-rows';

/** How far back an accepted prompt is looked for. A journal that has not posted by then is down. */
export const SENT_WINDOW_MS = 30 * 60 * 1000;
/** The most accepted inbox prompts listed: a burst of follow-ups during one turn. */
const SENT_LIMIT = 20;

/** Oldest first, as the log will order them. Empty when the log holds every accepted prompt. */
export async function listSentPrompts(sessionId: string, nowMs = Date.now()): Promise<SessionSentPrompt[]> {
  const since = new Date(nowMs - SENT_WINDOW_MS);
  const [delivered, initial] = await Promise.all([deliveredInboxPrompts(sessionId, since), initialPrompt(sessionId, since)]);
  const candidates = [...(initial ? [initial] : []), ...delivered];
  if (!candidates.length) return [];
  const held = await db
    .select({ messageId: sessionLogMessages.messageId })
    .from(sessionLogMessages)
    .where(
      and(
        eq(sessionLogMessages.sessionId, sessionId),
        inArray(
          sessionLogMessages.messageId,
          candidates.map((c) => c.message_id),
        ),
      ),
    );
  const logged = new Set(held.map((row) => row.messageId));
  const seen = new Set<string>();
  return candidates
    .filter((c) => !logged.has(c.message_id) && !seen.has(c.message_id) && seen.add(c.message_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Inbox rows a turn consumed (`result.status = 'delivered'`) inside the window. */
async function deliveredInboxPrompts(sessionId: string, since: Date): Promise<SessionSentPrompt[]> {
  const rows = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(
      and(
        inboxScope(sessionId),
        // Harness context, not a user prompt (KRTX-2597): an auto-recovery continuation
        // carries a `clientMessageId`; drawn as a user message it would put system text in a
        // person's mouth.
        sql`${sessionLifecycleCommands.payload}->>'resumesTurn' IS NULL`,
        eq(sessionLifecycleCommands.status, 'succeeded'),
        sql`${sessionLifecycleCommands.result}->>'status' = 'delivered'`,
        gt(sessionLifecycleCommands.updatedAt, since),
      ),
    )
    .orderBy(desc(sessionLifecycleCommands.updatedAt))
    .limit(SENT_LIMIT);
  return rows.flatMap((row) => {
    const prompt = serializePrompt(row);
    if (!prompt.message_id || prompt.synthetic) return [];
    return [
      {
        message_id: prompt.message_id,
        wire_message_id: prompt.wire_message_id && prompt.wire_message_id !== prompt.message_id ? prompt.wire_message_id : null,
        prompt_id: prompt.prompt_id,
        text: prompt.full_text,
        attachments: prompt.attachments,
        author_user_id: prompt.author_user_id ?? null,
        created_at: prompt.created_at,
      },
    ];
  });
}

/**
 * The session's `initial_prompt`, under the id its turn carries: the `activeTurns` entry the
 * daemon claims at boot, else the session's first turn. Null when the session has none, or
 * it was created before the window.
 */
async function initialPrompt(sessionId: string, since: Date): Promise<SessionSentPrompt | null> {
  const [session] = await db
    .select({ metadata: projectSessions.metadata, createdBy: projectSessions.createdBy, createdAt: projectSessions.createdAt })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const text = session?.metadata?.initial_prompt;
  if (!session || typeof text !== 'string' || !text.trim() || session.createdAt <= since) return null;
  // The earliest turn of the session, live (`activeTurns`) or ended (`session_turns`): an
  // entry moves from the first to the second when its turn ends.
  const [live, ended] = await Promise.all([firstLiveTurn(sessionId), firstLedgerTurn(sessionId)]);
  const first = [live, ended].filter((t) => t !== null).sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
  const messageId = first?.messageId;
  if (!messageId) return null;
  return {
    message_id: messageId,
    wire_message_id: null,
    prompt_id: null,
    text,
    attachments: [],
    author_user_id: session.createdBy ?? null,
    created_at: session.createdAt.toISOString(),
  };
}

type FirstTurn = { messageId: string; startedAtMs: number };

async function firstLiveTurn(sessionId: string): Promise<FirstTurn | null> {
  const [sandbox] = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  const turns = (sandbox?.metadata as Record<string, unknown> | null)?.activeTurns;
  if (!turns || typeof turns !== 'object' || Array.isArray(turns)) return null;
  const entries = Object.values(turns as Record<string, unknown>).flatMap((t) => {
    const turn = (t ?? {}) as { messageId?: unknown; startedAtMs?: unknown };
    return typeof turn.messageId === 'string' && typeof turn.startedAtMs === 'number'
      ? [{ messageId: turn.messageId, startedAtMs: turn.startedAtMs }]
      : [];
  });
  return entries.sort((a, b) => a.startedAtMs - b.startedAtMs)[0] ?? null;
}

async function firstLedgerTurn(sessionId: string): Promise<FirstTurn | null> {
  const [turn] = await db
    .select({ messageId: sessionTurns.messageId, startedAt: sessionTurns.startedAt })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), isNotNull(sessionTurns.messageId)))
    .orderBy(asc(sessionTurns.startedAt))
    .limit(1);
  return turn?.messageId ? { messageId: turn.messageId, startedAtMs: turn.startedAt.getTime() } : null;
}
