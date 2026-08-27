/**
 * Server truth about the turns a session is running RIGHT NOW.
 *
 * Extracted verbatim from `GET /:projectId/sessions/:sessionId/turn`
 * (`routes/r8.ts`) so a second reader — the session-open bundle — answers from
 * the SAME code rather than a second copy of this reasoning. Two projections of
 * one lifecycle authority is exactly how a client ends up holding two
 * disagreeing answers to "is this session working?".
 *
 * LIVENESS comes from the lifecycle authority (`session_sandboxes.metadata.
 * activeTurns`), never from the `kortix.session_turns` ledger: a stopped box
 * holds no live turn whatever its ledger rows still say. The ledger DECORATES
 * (accepted_at, message identity) and owns HISTORY (`last_ended`).
 *
 * Reads only. No auth, no visibility gate — the CALLER owns both, exactly as
 * the route does before it reaches this function.
 */

import { db } from '../../shared/db';
import { sessionSandboxes, sessionTurns } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { RUNNING_SANDBOX_STATUSES, storedSandboxTurns } from '../sandbox-turn-lifecycle';

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
    end_reason: string | null;
    ended_at: string | null;
  };
}

export async function readSessionTurnState(sessionId: string): Promise<SessionTurnState> {
  // `session_sandboxes.session_id` is UNIQUE, so this is the session's one
  // box. A box that is not running holds no live turn whatever its metadata
  // still says — the same predicate settleOrphanedSandboxTurns uses to close
  // every ledger row left open on a stopped box. Served by
  // idx_session_sandboxes_session (plain Index Scan; measured, see below).
  const [box] = await db
    .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  const authority =
    box && RUNNING_SANDBOX_STATUSES.has(box.status) ? storedSandboxTurns(box.metadata) : [];

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
  if (live.length > 0) return { turns: live };

  const [ended] = await db
    .select({
      turnToken: sessionTurns.turnToken,
      endReason: sessionTurns.endReason,
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
            end_reason: ended.endReason,
            ended_at: ended.endedAt ? ended.endedAt.toISOString() : null,
          },
        }
      : {}),
  };
}
