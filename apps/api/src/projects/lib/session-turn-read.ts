/**
 * Server truth about the turns a session is running RIGHT NOW.
 *
 * Extracted verbatim from `GET /:projectId/sessions/:sessionId/turn`
 * (`routes/session-runtime.ts`) so a second reader — the session-open bundle — answers from
 * the SAME code rather than a second copy of this reasoning. Two projections of
 * one lifecycle authority is exactly how a client ends up holding two
 * disagreeing answers to "is this session working?".
 *
 * LIVENESS comes from the lifecycle authority (`session_sandboxes.metadata.
 * activeTurns`), never from the `kortix.session_turns` ledger: a stopped box
 * holds no live turn whatever its ledger rows still say. The ledger DECORATES
 * (accepted_at, message identity) and owns HISTORY (`last_ended`).
 *
 * No auth or visibility gate — the CALLER owns both, exactly as
 * the route does before it reaches this function.
 */

import { scheduleSessionTurnRecovery } from '../session-lifecycle/inbox-turn-recovery';
import { db } from '../../shared/db';
import { sessionSandboxes, sessionTurns } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ABORT_END_ERROR_NAMES,
  RUNNING_SANDBOX_STATUSES,
  isRequestedStopName,
  storedSandboxTurns,
} from '../sandbox-turn-lifecycle';

/** One turn the control plane is holding open, in wire shape. */
export interface SessionTurnView {
  turn_token: string;
  state: string;
  message_id: string | null;
  opencode_session_id: string | null;
  started_at: string | null;
  accepted_at: string | null;
}

/** The `/turn` response body. `last_ended` is OMITTED, never null — see below. */
export interface SessionTurnState {
  turns: SessionTurnView[];
  last_ended?: {
    turn_token: string;
    /** The user message the turn answered. OMITTED for a turn nobody named. */
    message_id?: string;
    end_reason: string | null;
    ended_at: string | null;
    /** Why a `failed` turn ended. OMITTED when nobody named the failure. */
    error?: { name: string | null; message: string | null };
  };
  /**
   * Recent turns that FAILED, newest first, with the cause when one was named.
   * OMITTED when there are none. A turn the user stopped is not a failure and is
   * never listed. Reported whether or not a turn is running: `last_ended` is one
   * row and vanishes the moment the next turn starts, and a queued prompt starts
   * it seconds after a failure — the outcome has to stay findable by `message_id`.
   */
  recent_failures?: SessionTurnFailure[];
}

export interface SessionTurnFailure {
  message_id: string;
  ended_at: string | null;
  /** Null when the turn failed and nobody named why (a bare abort, or nothing). */
  error: { name: string | null; message: string | null } | null;
}

/** How many of a session's newest turns are searched for named failures. */
const RECENT_FAILURE_TURN_WINDOW = 50;

/**
 * From here on every requested stop is stamped (`UserStop`, `QueueInterrupt`),
 * so a `failed` row with no `end_error` is a death nobody explained, not a Stop.
 * Prod's first recorded `end_error` is 2026-08-20 22:00 UTC.
 */
export const END_ERROR_COLUMN_EPOCH_MS = Date.parse('2026-08-21T00:00:00Z');

/**
 * Bounded by turn count, not by failure count: this read is polled, and a
 * session with no failures must not scan its whole history to learn that.
 * Served by `session_turns_session_idx` (session_id, started_at DESC).
 *
 * A failure the user cannot see is the bug this read exists to end, so a turn is
 * listed whenever the ledger says it died:
 *
 *   - `runtime_gone`: the box vanished under it. Never a requested stop.
 *   - `failed` with a recorded error. A bare abort is the EFFECT of whatever
 *     stopped the turn, never a cause, so it reads as `error: null`.
 *
 *   - `failed` with NO recorded error, when it ended after the column existed.
 *     Nobody said why (a lost end frame, an old daemon), and saying nothing
 *     under a dead turn is worse than saying "no reason was reported". Prod
 *     2026-09-22: 20-30 % of failed turns per hour had no cause and were hidden.
 *
 * Not listed: a stop somebody asked for (`REQUESTED_STOP_NAMES`), and a `failed`
 * row with no recorded error from before `END_ERROR_COLUMN_EPOCH`. Before the
 * column, a user Stop and an unexplained abort were stored identically; listing
 * those would flag every turn anyone ever stopped.
 */
async function readRecentTurnFailures(sessionId: string): Promise<SessionTurnFailure[]> {
  const recent = await db
    .select({
      messageId: sessionTurns.messageId,
      endReason: sessionTurns.endReason,
      endError: sessionTurns.endError,
      endedAt: sessionTurns.endedAt,
    })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.state, 'ended')))
    .orderBy(desc(sessionTurns.startedAt))
    .limit(RECENT_FAILURE_TURN_WINDOW);
  const failures: SessionTurnFailure[] = [];
  for (const turn of recent) {
    if (!turn.messageId) continue;
    const name = turn.endError?.name ?? null;
    const died =
      turn.endReason === 'runtime_gone' ||
      (turn.endReason === 'failed' &&
        (turn.endError !== null ||
          (turn.endedAt !== null && turn.endedAt.getTime() >= END_ERROR_COLUMN_EPOCH_MS)));
    if (!died || isRequestedStopName(name)) continue;
    const named = turn.endError && !(name && ABORT_END_ERROR_NAMES.includes(name));
    failures.push({
      message_id: turn.messageId,
      ended_at: turn.endedAt ? turn.endedAt.toISOString() : null,
      error: named ? turn.endError : null,
    });
  }
  return failures;
}

export async function readSessionTurnState(sessionId: string): Promise<SessionTurnState> {
  // `session_sandboxes.session_id` is UNIQUE, so this is the session's one
  // box. A box that is not running holds no live turn whatever its metadata
  // still says — the same predicate settleOrphanedSandboxTurns uses to close
  // every ledger row left open on a stopped box. Served by
  // idx_session_sandboxes_session (plain Index Scan; measured, see below).
  const [box] = await db
    .select({
      status: sessionSandboxes.status,
      metadata: sessionSandboxes.metadata,
      sandboxId: sessionSandboxes.sandboxId,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  const authority =
    box && RUNNING_SANDBOX_STATUSES.has(box.status) ? storedSandboxTurns(box.metadata) : [];

  // Recovery stays off the response path. A reload can miss the runtime's
  // idle frame too; the next read must not keep serving a completed turn.
  if (box && authority.length > 0) scheduleSessionTurnRecovery({ ...box, sessionId });

  // Decoration only, keyed by the tokens the authority already named: the
  // ledger owns `accepted_at`, and it fills in an identity the authority may
  // not carry yet. It never adds or removes a turn — an open row whose token
  // the authority no longer holds is a swallowed settle, not a running turn.
  // Bounded by the authority's own token list, so this is a primary-key
  // lookup and needs no ORDER BY and no LIMIT: measured as `Index Scan using
  // session_turns_pkey (turn_token = ANY (...))`, with the session scope as a
  // filter — kept because a token must never read another session's row.
  const ledger = new Map<
    string,
    {
      messageId: string | null;
      opencodeSessionId: string | null;
      startedAt: Date;
      acceptedAt: Date | null;
    }
  >();
  if (authority.length > 0) {
    const rows = await db
      .select({
        turnToken: sessionTurns.turnToken,
        messageId: sessionTurns.messageId,
        opencodeSessionId: sessionTurns.opencodeSessionId,
        startedAt: sessionTurns.startedAt,
        acceptedAt: sessionTurns.acceptedAt,
      })
      .from(sessionTurns)
      .where(
        and(
          eq(sessionTurns.sessionId, sessionId),
          inArray(
            sessionTurns.turnToken,
            authority.map((turn) => turn.token),
          ),
        ),
      );
    for (const row of rows) ledger.set(row.turnToken, row);
}

  const live = authority
    .map((turn) => {
      const row = ledger.get(turn.token);
      // The authority's own instant first: it is what the grant statement
      // wrote. The ledger start is the fallback for a legacy `activeTurn`
      // record, which carries none.
      const startedAt =
        turn.startedAtMs !== null ? new Date(turn.startedAtMs) : (row?.startedAt ?? null);
      return {
        startedAtMs: startedAt ? startedAt.getTime() : null,
        turn: {
          turn_token: turn.token,
          // State comes from the authority: `acceptSandboxTurn` promotes the
          // authority entry in statement one and UPSERTs the ledger in
          // statement two, so a swallowed second write leaves the row saying
          // `delivering` for a turn OpenCode has accepted.
          state: turn.state,
          message_id: turn.messageId ?? row?.messageId ?? null,
          opencode_session_id: turn.opencodeSessionId || row?.opencodeSessionId || null,
          started_at: startedAt ? startedAt.toISOString() : null,
          accepted_at: row?.acceptedAt ? row.acceptedAt.toISOString() : null,
        },
      };
    })
    // Newest start first, then by token so two turns minted in the same
    // millisecond — or two legacy records with no instant at all — still
    // come back in a stable order.
    .sort(
      (a, b) =>
        (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0) ||
        a.turn.turn_token.localeCompare(b.turn.turn_token),
    )
    .map((entry) => entry.turn);
  const failures = await readRecentTurnFailures(sessionId);
  const recentFailures = failures.length > 0 ? { recent_failures: failures } : {};
  if (live.length > 0) return { turns: live, ...recentFailures };

  const [ended] = await db
    .select({
      turnToken: sessionTurns.turnToken,
      messageId: sessionTurns.messageId,
      endReason: sessionTurns.endReason,
      endError: sessionTurns.endError,
      endedAt: sessionTurns.endedAt,
    })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.state, 'ended')))
    // `ended_at` is nullable, so it cannot order this on its own. Measured
    // with EXPLAIN ANALYZE on real Postgres at 20k rows over 200 sessions:
    // `Bitmap Index Scan on session_turns_session_idx` for the session scope,
    // then a top-N heapsort over that session's rows only — the index orders
    // by started_at, not by ended_at, so the sort is expected and bounded by
    // one session's history.
    .orderBy(desc(sessionTurns.endedAt), desc(sessionTurns.startedAt))
    .limit(1);
  // `last_ended` is OMITTED, never null: its absence is the only thing that
  // separates "this session has never run a turn" from "the last one ended".
  // It is HISTORY, and history is what the swallowed ledger write costs: a
  // lost settle leaves the previous terminal row as the newest one. Liveness
  // above does not depend on it.
  return {
    turns: [],
    ...(ended
      ? {
          last_ended: {
            turn_token: ended.turnToken,
            ...(ended.messageId ? { message_id: ended.messageId } : {}),
            end_reason: ended.endReason,
            ended_at: ended.endedAt ? ended.endedAt.toISOString() : null,
            // A requested stop is bookkeeping, not an error to report.
            ...(ended.endError && !isRequestedStopName(ended.endError.name)
              ? { error: ended.endError }
              : {}),
          },
        }
      : {}),
    ...recentFailures,
  };
}
