/**
 * Platform notices into a session, coalesced: "a background subagent
 * finished", "a teammate is idle", "the session you messaged is idle".
 *
 * THE PROBLEM. A lead that starts five background agents gets five notices,
 * often within a second of each other. One durable row per notice meant one
 * delivery per row: the first woke the session and started a turn, and each
 * later row that missed that turn's steer window queued behind it and started
 * a turn of its own. Five notices, five turns, five wake-ups, and the person's
 * own next message waits behind all of them.
 *
 * THE RULE. While a notice row for a session is still `queued` (not claimed),
 * a new notice for the same session and the same acting person is appended to
 * it instead of becoming a row of its own. Each row waits `NOTICE_BATCH_HOLD_MS`
 * before its first delivery, so notices that arrive together become ONE
 * delivery: one wake of a stopped box, one turn of an idle one, one steer into
 * a running turn. A notice that arrives after the row was claimed starts the
 * next row; it steers into the turn the first row started.
 *
 * The row is an inbox prompt with a synthetic part (`clientMessageId`, a
 * `steer` delivery, `placement: composer`), as `subagent-notice.ts` wrote it
 * before, so the transcript shows it as a notice and a running turn reads it
 * between steps when the turn's prompter is the row's actor. The dedupe keys
 * of every notice in the row are kept in `payload.noticeKeys`; a repeat of any
 * of them inserts nothing.
 *
 * One advisory lock per session serializes the enqueuers, so two notices that
 * race cannot both miss each other's row.
 */
import { sessionLifecycleCommands } from '@kortix/db';
import { and, eq, or, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from './session-lifecycle';
import type { SessionInvocationSource } from './session-lifecycle/types';
import { mintWireMessageId } from './wire-message-id';

/** How long a notice row waits for more notices before its first delivery. */
export const NOTICE_BATCH_HOLD_MS = 1_500;
/** Notices one row carries at most; the next notice starts a new row. */
export const NOTICE_BATCH_MAX = 20;
const SEPARATOR = '\n\n';

let holdMs = NOTICE_BATCH_HOLD_MS;
/** Tests shrink the hold; never called in production. */
export function setNoticeBatchHoldForTests(ms: number): void {
  holdMs = ms;
}

export interface SessionNotice {
  source: SessionInvocationSource;
  projectId: string;
  accountId: string;
  /** The session that receives the notice. */
  sessionId: string;
  /** The person the delivered turn acts as. A running turn takes the steer only from its prompter. */
  actorUserId: string | null;
  text: string;
  /** Dedupe key: a second notice with the same key inserts nothing. */
  key: string;
  /** The session the notice is about, for the transcript's author. */
  authorSessionId?: string | null;
}

export interface EnqueuedNotice {
  /** The row's own key (the first notice's key). */
  rowKey: string;
  deduped: boolean;
  /** True when the notice joined a row that was already waiting. */
  coalesced: boolean;
}

type NoticePayload = {
  text?: string;
  parts?: { type: string; text: string; synthetic?: boolean }[];
  noticeBatch?: boolean;
  noticeKeys?: string[];
};

/** Enqueue one notice, appended to the session's waiting notice row when one exists. */
export async function enqueueSessionNotice(notice: SessionNotice): Promise<EnqueuedNotice> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notice-batch:${notice.sessionId}`}))`);
    const [seen] = await tx
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(or(
        eq(sessionLifecycleCommands.idempotencyKey, notice.key),
        and(
          eq(sessionLifecycleCommands.sessionId, notice.sessionId),
          sql`${sessionLifecycleCommands.payload}->'noticeKeys' @> ${JSON.stringify([notice.key])}::jsonb`,
        ),
      ))
      .limit(1);
    if (seen) return { rowKey: notice.key, deduped: true, coalesced: false };

    const [pending] = await tx
      .select({
        commandId: sessionLifecycleCommands.commandId,
        idempotencyKey: sessionLifecycleCommands.idempotencyKey,
        payload: sessionLifecycleCommands.payload,
      })
      .from(sessionLifecycleCommands)
      .where(and(
        eq(sessionLifecycleCommands.sessionId, notice.sessionId),
        sql`${sessionLifecycleCommands.status} = 'queued'`,
        sql`${sessionLifecycleCommands.payload}->>'noticeBatch' = 'true'`,
        notice.actorUserId
          ? eq(sessionLifecycleCommands.actorUserId, notice.actorUserId)
          : sql`${sessionLifecycleCommands.actorUserId} is null`,
        sql`jsonb_array_length(coalesce(${sessionLifecycleCommands.payload}->'noticeKeys', '[]'::jsonb)) < ${NOTICE_BATCH_MAX}`,
      ))
      .limit(1)
      .for('update');
    if (pending?.idempotencyKey) {
      const payload = pending.payload as NoticePayload;
      const text = `${payload.text ?? ''}${SEPARATOR}${notice.text}`;
      const next: NoticePayload = {
        ...payload,
        text,
        parts: [{ type: 'text', text, synthetic: true }],
        noticeKeys: [...(payload.noticeKeys ?? []), notice.key],
      };
      await tx.update(sessionLifecycleCommands)
        .set({ payload: next as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(sessionLifecycleCommands.commandId, pending.commandId));
      return { rowKey: pending.idempotencyKey, deduped: false, coalesced: true };
    }

    const values = buildContinueSessionCommandValues({
      source: notice.source,
      projectId: notice.projectId,
      accountId: notice.accountId,
      sessionId: notice.sessionId,
      actorUserId: notice.actorUserId,
      text: notice.text,
      // Harness context, not the person's words: the transcript shows it as a notice.
      parts: [{ type: 'text', text: notice.text, synthetic: true }],
      idempotencyKey: notice.key,
      clientMessageId: notice.key,
      wireMessageId: mintWireMessageId({ nowMs: Date.now() }).id,
      remintOnDelivery: true,
      placement: 'composer',
      delivery: 'steer',
      authorSessionId: notice.authorSessionId ?? null,
      availableAt: new Date(Date.now() + holdMs),
    });
    await tx.insert(sessionLifecycleCommands)
      .values({ ...values, payload: { ...values.payload, noticeBatch: true, noticeKeys: [notice.key] } })
      .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    return { rowKey: notice.key, deduped: false, coalesced: false };
  });
  if (!result.deduped && !result.coalesced) scheduleKick(result.rowKey);
  return result;
}

/**
 * Deliver the row when its hold ends. The 1 s lifecycle worker drains it too;
 * this only saves that second. Unref'd: it never holds a shutdown.
 */
function scheduleKick(rowKey: string): void {
  const timer = setTimeout(() => {
    drainSessionLifecycleQueue({ idempotencyKey: rowKey, burst: false }).catch((err) => {
      logger.warn('[notice-batch] kick failed; the lifecycle worker delivers it', {
        rowKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, holdMs + 50);
  (timer as { unref?: () => void }).unref?.();
}
