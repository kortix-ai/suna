/**
 * Durable active-turn authority for sandbox lifecycle renewal.
 *
 * `deadline_at` answers when an idle sandbox stops. It cannot also answer
 * whether an OpenCode turn is active. A local tool can run without an LLM call
 * for longer than one deadline grant. This module stores that separate fact in
 * `session_sandboxes.metadata.activeTurns`.
 *
 * Only the control plane can create a turn record. Promotion requires either
 * the API's accepted upstream response or daemon evidence tied to that record's
 * opaque token. Terminal evidence removes the record and shortens the deadline.
 * Renewal requires a fresh control-plane observation of the exact OpenCode
 * turn. A durable record cannot renew itself when OpenCode is unreachable.
 *
 * The `session_turns` ledger — every statement that records what these writes
 * erased — lives in ./session-turn-ledger.ts; every writer here records
 * through it.
 */

import { randomUUID } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import type { DeadlineTarget } from './sandbox-deadline';
import { contractIdleDeadline } from './sandbox-deadline';
import {
  idleGraceMs,
  isTerminalTurnEnd,
  sandboxStopClaimLeaseMs,
  turnDeliveryGraceMs,
  turnGrantMs,
} from './sandbox-deadline-policy';
import { confirmInboxPromptConsumed } from './session-lifecycle/consumption';
import {
  ABORT_END_ERROR_NAMES,
  type ActiveTurnRenewal,
  type RuntimeTurnAdoption,
  type SandboxTurnCompletionOutcome,
  type SandboxTurnCompletionResult,
  type SandboxTurnDeliveryReconciliation,
  type SandboxTurnEndError,
  type SandboxTurnIdentity,
  type SandboxTurnObservation,
  type SandboxTurnStart,
  type SandboxTurnStartObservation,
  type SessionTurnEndErrorRecord,
  type SessionTurnEndReason,
  activeTurnEntries,
  endErrorRecord,
  endedLedgerTurns,
  endedTurnLedger,
  execute,
  isProtectedEndError,
  ledgerIdentity,
  ledgerText,
  normalizeRows,
  recordTurnLedger,
  refineEndedTurnError,
  removeAndReturnTurns,
  reviveAbandonedTurnOnCompletion,
  secs,
  wasSandboxTurnAlreadyClosed,
} from './session-turn-ledger';

function targetPredicate(target: DeadlineTarget) {
  if ('sandboxId' in target) return sql`s.sandbox_id = ${target.sandboxId}::uuid`;
  if ('sessionId' in target) return sql`s.session_id = ${target.sessionId}`;
  return sql`s.external_id = ${target.externalId}`;
}

function jsonbObject(value: SQL): SQL {
  return sql`CASE
    WHEN jsonb_typeof(${value}) = 'object' THEN ${value}
    ELSE '{}'::jsonb
  END`;
}


/**
 * The FOR UPDATE read of one session's live sandbox row, as the `target` CTE
 * body both multi-turn end writers start from.
 */
function sandboxTurnTargetCte(sessionId: string): SQL {
  return sql`SELECT s.sandbox_id,
             ${jsonbObject(sql`s.metadata`)} AS metadata
        FROM kortix.session_sandboxes s
       WHERE s.session_id = ${sessionId}
         AND s.status IN ('active', 'provisioning')
       FOR UPDATE OF s`;
}

/**
 * The `all_active_turns ... selected` CTE chain of completeSandboxTurn: every
 * live turn of the session, narrowed to the end frame's OpenCode identity, an
 * exact-message match taking precedence over the newest fallback. It follows
 * the `target` CTE, so the fragment opens with a comma.
 */
function turnSelectionCtes(identity?: Partial<SandboxTurnIdentity> | null): SQL {
  return sql`, all_active_turns AS (
      SELECT target.sandbox_id,
             coalesce(entry.value->>'token', entry.key) AS token
        FROM target
        CROSS JOIN LATERAL ${activeTurnEntries(sql`target.metadata`)}
       WHERE entry.value->>'state' IN ('delivering', 'active')
    ), turn_candidates AS (
      SELECT target.sandbox_id,
             entry.key,
             entry.value->>'token' AS token,
             entry.value
        FROM target
        CROSS JOIN LATERAL ${activeTurnEntries(sql`target.metadata`)}
       WHERE entry.value->>'state' IN ('delivering', 'active')
         AND (coalesce(entry.value->>'runtimeSessionId', entry.value->>'opencodeSessionId') IS NULL
           OR (${identity?.runtimeSessionId ?? null}::text IS NOT NULL
             AND coalesce(entry.value->>'runtimeSessionId', entry.value->>'opencodeSessionId')
               = ${identity?.runtimeSessionId ?? null}))
    ), exact_matches AS (
      SELECT candidate.sandbox_id, candidate.key, candidate.token,
             candidate.value
        FROM turn_candidates candidate
       WHERE ${identity?.messageId ?? null}::text IS NOT NULL
         AND candidate.value->>'messageId' = ${identity?.messageId ?? null}
    ), fallback_match AS (
      SELECT candidate.sandbox_id, candidate.key, candidate.token,
             candidate.value
        FROM turn_candidates candidate
       WHERE candidate.value->>'messageId' IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM exact_matches exact
            WHERE exact.sandbox_id = candidate.sandbox_id)
       ORDER BY CASE
         WHEN candidate.value->>'startedAtMs' ~ '^[0-9]+$'
           THEN (candidate.value->>'startedAtMs')::bigint
         ELSE 9223372036854775807
       END, candidate.key
       LIMIT 1
    ), selected AS (
      SELECT * FROM exact_matches
      UNION ALL
      SELECT * FROM fallback_match
    )`;
}

/**
 * Record a control-plane-observed delivery attempt before the upstream call.
 * The short grace covers delivery only. A confirmed response promotes the same
 * token to `active`; a fast terminal event can delete it first and win the CAS.
 */
export async function beginSandboxTurn(
  target: DeadlineTarget,
  turn: SandboxTurnStart,
  graceMs = turnDeliveryGraceMs(),
  observedAtMs?: number,
): Promise<SandboxTurnStartObservation> {
  const metadata = jsonbObject(sql`s.metadata`);
  const activeTurns = jsonbObject(sql`s.metadata->'activeTurns'`);
  const observedAt =
    observedAtMs === undefined
      ? sql`now()`
      : sql`${new Date(observedAtMs).toISOString()}::timestamptz`;
  const grant = sql`
      UPDATE kortix.session_sandboxes s
         SET metadata = jsonb_set(
               ${metadata} - 'lifecycleStopClaim',
               '{activeTurns}',
               ${activeTurns} || jsonb_build_object(
                 ${turn.token}::text,
                 jsonb_build_object(
                   'token', ${turn.token}::text,
                   'state', 'delivering',
                   'runtimeSessionId', ${turn.runtimeSessionId}::text,
                   'opencodeSessionId', ${turn.runtimeSessionId}::text,
                   'messageId', ${turn.messageId}::text,
                   'startedAtMs', floor(extract(epoch from ${observedAt}) * 1000))),
               true),
             deadline_at = GREATEST(
               s.deadline_at,
               ${observedAt} + make_interval(secs => ${secs(graceMs)})),
             updated_at = now()
      WHERE ${targetPredicate(target)}
        AND s.status IN ('active', 'provisioning')
        AND (
          s.metadata->'lifecycleStopClaim' IS NULL
          OR s.metadata->'lifecycleStopClaim'->>'claimedAtMs' !~ '^[0-9]+$'
          OR (s.metadata->'lifecycleStopClaim'->>'claimedAtMs')::bigint
            <= floor(extract(epoch from ${observedAt}) * 1000) - ${sandboxStopClaimLeaseMs()})
      RETURNING s.sandbox_id, s.session_id, s.project_id, s.account_id, true AS granted`;
  // ONE statement: the ledger row is written from the rows the grant itself
  // returned, so a stop cannot commit between the two (it waits on the sandbox
  // row lock and then settles this row, or lands first and the grant matches
  // nothing). It ran as a second round trip before the prompt's upstream call.
  const { withDbTransaction } = await import('../shared/db');
  const result = await withDbTransaction(async () => {
    await execute(sql`SELECT session.session_id FROM kortix.project_sessions session
      WHERE session.session_id IN (SELECT s.session_id FROM kortix.session_sandboxes s WHERE ${targetPredicate(target)})
      FOR UPDATE OF session`);
    const result = await withLedger(
      grant,
      sql`WITH granted AS (${grant}), ledger AS (
            INSERT INTO kortix.session_turns
              (turn_token, session_id, sandbox_id, project_id, account_id,
               opencode_session_id, message_id, state, started_at, created_at, updated_at)
            SELECT ${turn.token}, granted.session_id, granted.sandbox_id,
                   granted.project_id, granted.account_id,
                   ${turn.runtimeSessionId || null}, ${turn.messageId}, 'delivering',
                   ${observedAt}, now(), now()
              FROM granted
             WHERE granted.session_id IS NOT NULL
               AND granted.project_id IS NOT NULL
               AND granted.account_id IS NOT NULL
            ON CONFLICT (turn_token) DO NOTHING)
          SELECT * FROM granted`,
      `insert delivering ${turn.token}`,
    );
    const granted = normalizeRows(result);
    if (granted?.[0]?.session_id) {
      const { transitionSession } = await import('./session-lifecycle/status-transitions');
      await transitionSession('wake', String(granted[0].session_id), { error: null });
    }
    return result;
  });
  const rows = normalizeRows(result);
  if (rows === null) {
    throw new Error('sandbox turn lifecycle write returned an unsupported database result');
  }
  return rows.length === 0 ? 'no_box' : 'granted';
}

/**
 * Run an authority write together with its ledger row. The ledger is
 * observation: when the combined statement fails, the authority write runs
 * alone, so a ledger fault never fails a prompt or a turn acceptance.
 */
async function withLedger(authority: SQL, combined: SQL, context: string) {
  try {
    // Nested contextual transaction is a savepoint: a ledger statement error
    // must not poison admission's outer authority + wake transaction.
    const { withDbTransaction } = await import('../shared/db');
    return await withDbTransaction(() => execute(combined));
  } catch (error) {
    logger.warn(
      `[turn-ledger] ${context} failed with its authority write; retrying the authority write alone:`,
      error instanceof Error ? error.message : error,
    );
    return execute(authority);
  }
}

/**
 * Give a BOX-INITIATED turn the same durable authority a delivered prompt gets.
 *
 * Not every turn starts with `POST .../prompts`. OpenCode starts turns of its
 * own — most commonly the synthetic `<pty_exited>` user message it injects when
 * a background pty finishes — and those turns had NO `session_turns` row, no
 * `activeTurns` record, and therefore no deadline grant: `GET .../turn`
 * reported idle for minutes of live streaming, the composer read "not
 * running" over a working session, and a long pty-driven work phase ran on
 * the 15-minute idle tail (live incident 2026-08-20, a SampleCo
 * session). The daemon now relays `turn_begin` when it observes the root go
 * busy; this is that relay's write.
 *
 * Idempotent by construction, so the daemon may relay freely:
 * - a message id the ledger has EVER seen is refused — a late `turn_begin`
 *   must not resurrect a turn the reaper or a turn-end already closed;
 * - any still-open row for this sandbox means authority is already held —
 *   including the normal case where the control plane wrote the record before
 *   delivering the prompt — and nothing is written.
 */
export async function adoptRuntimeSandboxTurn(
  sandboxId: string,
  identity: { runtimeSessionId: string; messageId: string },
): Promise<RuntimeTurnAdoption> {
  const guard = await execute(sql`
    SELECT
      EXISTS(
        SELECT 1 FROM kortix.session_turns t
         WHERE t.sandbox_id = ${sandboxId}::uuid
           AND t.message_id = ${identity.messageId}) AS known,
      EXISTS(
        SELECT 1 FROM kortix.session_turns t
         WHERE t.sandbox_id = ${sandboxId}::uuid
           AND t.state <> 'ended') AS open`);
  const rows = normalizeRows(guard);
  const known = rows?.[0]?.known === true;
  const open = rows?.[0]?.open === true;
  if (known) return 'known_message';
  if (open) return 'open_turn_exists';
  const token = randomUUID();
  const started = await beginSandboxTurn({ sandboxId }, { token, ...identity });
  if (started !== 'granted') return 'no_box';
  const accepted = await acceptSandboxTurn({ sandboxId }, token, identity);
  return accepted ? 'adopted' : 'no_box';
}

/** Promote only the delivery record created by this request. */
export async function acceptSandboxTurn(
  target: DeadlineTarget,
  token: string,
  identity?: Partial<SandboxTurnIdentity> | null,
  grantMs = turnGrantMs(),
): Promise<boolean> {
  const promote = sql`
    UPDATE kortix.session_sandboxes s
       SET metadata = jsonb_set(
             s.metadata,
             ARRAY['activeTurns', ${token}]::text[],
             (s.metadata->'activeTurns'->${token}) || jsonb_strip_nulls(jsonb_build_object(
               'state', 'active',
               'runtimeSessionId', ${identity?.runtimeSessionId ?? null}::text,
               'opencodeSessionId', ${identity?.runtimeSessionId ?? null}::text,
               'messageId', ${identity?.messageId ?? null}::text)),
             false),
           deadline_at = GREATEST(
             s.deadline_at,
             now() + make_interval(secs => ${secs(grantMs)})),
           updated_at = now()
     WHERE ${targetPredicate(target)}
       AND s.status IN ('active', 'provisioning')
       AND s.metadata->'activeTurns'->${token}->>'token' = ${token}
       AND s.metadata->'activeTurns'->${token}->>'state' IN ('delivering', 'active')
    RETURNING s.sandbox_id, s.session_id, s.project_id, s.account_id, true AS accepted,
              s.metadata->'activeTurns'->${token}->>'messageId' AS turn_message_id`;
  // UPSERT, not UPDATE: a boot prompt is written straight into `activeTurns`
  // by initialSandboxTurnMetadata and never passes through beginSandboxTurn,
  // so acceptance is that turn's first ledger write. One statement with the
  // promotion, for the same reason as beginSandboxTurn's.
  const result = await withLedger(
    promote,
    sql`WITH accepted AS (${promote}), ledger AS (
          INSERT INTO kortix.session_turns
            (turn_token, session_id, sandbox_id, project_id, account_id,
             opencode_session_id, message_id, state, started_at, accepted_at, created_at, updated_at)
          SELECT ${token}, accepted.session_id, accepted.sandbox_id,
                 accepted.project_id, accepted.account_id,
                 ${identity?.runtimeSessionId ?? null}, ${identity?.messageId ?? null},
                 'active', now(), now(), now(), now()
            FROM accepted
           WHERE accepted.session_id IS NOT NULL
             AND accepted.project_id IS NOT NULL
             AND accepted.account_id IS NOT NULL
          ON CONFLICT (turn_token) DO UPDATE SET
                state = 'active',
                accepted_at = coalesce(kortix.session_turns.accepted_at, now()),
                opencode_session_id = coalesce(EXCLUDED.opencode_session_id, kortix.session_turns.opencode_session_id),
                message_id = coalesce(EXCLUDED.message_id, kortix.session_turns.message_id),
                updated_at = now()
          WHERE kortix.session_turns.state <> 'ended')
        SELECT * FROM accepted`,
    `accept ${token}`,
  );
  const rows = normalizeRows(result);
  const accepted = (rows?.length ?? 0) > 0;
  if (!accepted) return false;

  const owner = ledgerIdentity(rows?.[0]);
  if (owner) {
    // ACCEPTANCE IS THE INBOX'S ANSWER. The upstream took the prompt and the
    // ledger now holds an `active` turn keyed to this exact wire id, so the
    // message belongs to the transcript rather than to the queue — whether or
    // not OpenCode has started running it yet.
    //
    // THE ID COMES FROM THE ROW, not only from the argument. The one caller
    // that carries an inbox prompt is the proxy (`preview.ts`'s
    // `acceptTurnLifecycle`), and it passes NO identity — the identity was
    // written durably by `beginSandboxTurn` before the POST, so re-sending it
    // would be re-sending what the record already holds. Reading only the
    // argument made this confirmation dead on every composer prompt, and the
    // row stayed `delivering` until the whole turn ended.
    //
    // Same swallow-and-log shape as the ledger write above, and for the same
    // reason: this is bookkeeping, and a failed confirmation must never fail a
    // turn acceptance.
    await confirmInboxPromptConsumed(
      owner.sessionId,
      identity?.messageId ?? ledgerText(rows?.[0]?.turn_message_id),
    );
  }
  return true;
}

/** Remove a delivery record only when this request still owns it. */
export async function abandonSandboxTurn(target: DeadlineTarget, token: string): Promise<boolean> {
  // The record has to be read BEFORE it is erased: `RETURNING` sees the new row
  // version, so the entry this settle needs is already gone by then. Same
  // FOR UPDATE read-then-write shape as clearSandboxTurn.
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id, s.session_id, s.project_id, s.account_id,
             s.metadata->'activeTurns'->${token} AS turn,
             jsonb_set(
               coalesce(s.metadata, '{}'::jsonb),
               '{activeTurns}',
               coalesce(s.metadata->'activeTurns', '{}'::jsonb) - ${token},
               true) AS metadata
        FROM kortix.session_sandboxes s
       WHERE ${targetPredicate(target)}
         AND s.metadata->'activeTurns'->${token}->>'token' = ${token}
         AND s.metadata->'activeTurns'->${token}->>'state' = 'delivering'
       FOR UPDATE OF s
    )
    UPDATE kortix.session_sandboxes s
       SET metadata = target.metadata,
           updated_at = now()
      FROM target
     WHERE s.sandbox_id = target.sandbox_id
    RETURNING target.sandbox_id, target.session_id, target.project_id, target.account_id,
              target.turn, true AS abandoned`);
  const rows = normalizeRows(result);
  const abandoned = rows === null || rows.length > 0;
  if (!abandoned) return false;

  // A delivery that never reached OpenCode still happened. Without this the row
  // beginSandboxTurn inserted stays `delivering` forever, and a boot prompt the
  // daemon reports abandoned leaves no history at all.
  const owner = ledgerIdentity(rows?.[0]);
  const turns = endedLedgerTurns(rows?.[0]?.turn);
  if (owner) {
    await recordTurnLedger(
      endedTurnLedger(
        owner,
        turns.length > 0
          ? turns
          : [{ token, runtimeSessionId: null, messageId: null, startedAtMs: null }],
        'abandoned',
      ),
      `abandon ${token}`,
    );
  }
  return true;
}

/**
 * Repair the delivery-to-acceptance gap from provider-neutral OpenCode evidence.
 *
 * `reason` is what the daemon reported about a turn it says is no longer in
 * flight. The default is `abandoned`, not `completed`: this function only ever
 * sees turns still in `delivering`, i.e. turns NOTHING has confirmed reached
 * OpenCode, and the daemon answers `turn_in_flight === false` for a prompt it
 * never received exactly as it does for one that finished.
 */
export async function reconcileSandboxTurnDelivery(
  sandboxId: string,
  token: string,
  observation: SandboxTurnObservation,
  reason: SessionTurnEndReason = 'abandoned',
): Promise<SandboxTurnDeliveryReconciliation> {
  if (observation === 'active') {
    return (await acceptSandboxTurn({ sandboxId }, token)) ? 'active' : 'inactive';
  }
  if (observation === 'terminal') {
    await clearSandboxTurn(sandboxId, token, undefined, reason);
    return 'inactive';
  }
  // Unknown evidence cannot extend authority. The delivery grace was persisted
  // before prompt delivery and remains the only timeout for this state.
  return 'deferred';
}

/**
 * Remove terminal state only when the reaper still owns the observed token.
 * Contract the deadline when this was the final turn. This matches the direct
 * terminal relay and prevents a recovered terminal turn from retaining the
 * prior active-turn grant.
 */
export async function clearSandboxTurn(
  sandboxId: string,
  token: string,
  graceMs = idleGraceMs(),
  reason: SessionTurnEndReason = 'runtime_gone',
  /** What the control plane saw, recorded only when the turn has no cause yet. */
  cause: SessionTurnEndErrorRecord | null = null,
): Promise<boolean> {
  const metadata = jsonbObject(sql`s.metadata`);
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id, s.session_id, s.project_id, s.account_id,
             ${metadata}->'activeTurns'->${token} AS turn,
             jsonb_set(
               ${metadata},
               '{activeTurns}',
               coalesce(${metadata}->'activeTurns', '{}'::jsonb) - ${token},
               true) AS metadata
        FROM kortix.session_sandboxes s
       WHERE s.sandbox_id = ${sandboxId}::uuid
         AND s.status = 'active'
         AND ${metadata}->'activeTurns'->${token}->>'token' = ${token}
       FOR UPDATE OF s
    )
    UPDATE kortix.session_sandboxes s
       SET metadata = target.metadata,
           deadline_at = ${contractIdleDeadline(sql`target.metadata`, graceMs)},
           updated_at = now()
      FROM target
     WHERE s.sandbox_id = target.sandbox_id
    RETURNING target.sandbox_id, target.session_id, target.project_id, target.account_id,
              target.turn, true AS cleared`);
  const rows = normalizeRows(result);
  const cleared = (rows?.length ?? 0) > 0;
  if (!cleared) return false;

  const owner = ledgerIdentity(rows?.[0]);
  const turns = endedLedgerTurns(rows?.[0]?.turn);
  if (owner) {
    await recordTurnLedger(
      endedTurnLedger(
        owner,
        turns.length > 0
          ? turns
          : [{ token, runtimeSessionId: null, messageId: null, startedAtMs: null }],
        reason,
        cause,
        cause !== null,
      ),
      `clear ${token} (${reason})`,
    );
  }
  return true;
}

/**
 * The `turns.length === 0` branch of completeSandboxTurn: the authority write
 * erased nothing. Either the ledger already closed this exact message — refine
 * a missing cause, revive a false abandon, and report `already_closed` — or
 * the frame does not match any live turn.
 */
async function settleAlreadyClosedTurn(
  sessionId: string,
  status: 'idle' | 'error',
  identity: Partial<SandboxTurnIdentity> | null | undefined,
  endError: SessionTurnEndErrorRecord | null,
  activeTurnCount: number,
): Promise<SandboxTurnCompletionResult> {
  if (!(await wasSandboxTurnAlreadyClosed(sessionId, identity))) {
    return {
      outcome: activeTurnCount > 0 ? 'identity_mismatch' : 'no_active_turn',
      activeTurnCount,
      closedTurnCount: 0,
    };
  }
  if (identity && endError && isProtectedEndError(endError.name)) {
    await recordTurnLedger(
      refineEndedTurnError(sessionId, identity, endError),
      `refine end error ${identity.messageId} (${endError.name})`,
    );
  }
  // Same abort guard as the refine above: an abort names the EFFECT
  // (something asked this turn to stop), never the cause, so it must not
  // overwrite a reason the ledger already recorded — including a false
  // `abandoned` one. Only a genuine idle/error verdict revives the row.
  if (identity && (!endError?.name || !ABORT_END_ERROR_NAMES.includes(endError.name))) {
    // `wasSandboxTurnAlreadyClosed` only returns true with a messageId, so
    // `identity.messageId` is guaranteed here.
    const revivedReason: 'completed' | 'failed' = status === 'error' ? 'failed' : 'completed';
    await recordTurnLedger(
      reviveAbandonedTurnOnCompletion(sessionId, identity, revivedReason, endError),
      `revive abandoned ${identity.messageId} (${revivedReason})`,
    );
  }
  return {
    outcome: 'already_closed',
    activeTurnCount,
    closedTurnCount: 0,
  };
}

export async function completeSandboxTurn(
  sessionId: string,
  status: 'idle' | 'error',
  identity?: Partial<SandboxTurnIdentity> | null,
  error?: SandboxTurnEndError | null,
  graceMs = idleGraceMs(),
): Promise<SandboxTurnCompletionResult> {
  if (!isTerminalTurnEnd(status, error)) {
    return { outcome: 'non_terminal', activeTurnCount: 0, closedTurnCount: 0 };
  }
  const { withDbTransaction } = await import('../shared/db');
  const result = await withDbTransaction(async () => {
    // Match lifecycle writers' session -> sandbox lock order.
    await execute(sql`SELECT session_id FROM kortix.project_sessions
      WHERE session_id = ${sessionId} FOR UPDATE`);
    const result = await execute(sql`
    WITH target AS (${sandboxTurnTargetCte(sessionId)})${turnSelectionCtes(identity)}
    , next_state AS (${removeAndReturnTurns()})
    UPDATE kortix.session_sandboxes s
       SET metadata = next_state.metadata,
           deadline_at = ${contractIdleDeadline(sql`next_state.metadata`, graceMs)},
           updated_at = now()
      FROM next_state
     WHERE s.sandbox_id = next_state.sandbox_id
    RETURNING next_state.ended_turns,
              (SELECT count(*)::int FROM ${activeTurnEntries(sql`next_state.metadata`)}
                WHERE entry.value->>'state' IN ('delivering', 'active')) AS remaining_turn_count,
              (SELECT count(*)::int
                 FROM all_active_turns candidate
                WHERE candidate.sandbox_id = next_state.sandbox_id) AS active_turn_count,
              s.session_id, s.sandbox_id, s.project_id, s.account_id,
              true AS completed`);
    const completed = normalizeRows(result)?.[0];
    const closed = endedLedgerTurns(completed?.ended_turns);
    // active_turn_count is the historical pre-removal public result. Parking
    // depends on the authority left AFTER this exact completion instead.
    if (
      status === 'error' &&
      closed.length > 0 &&
      Number(completed?.remaining_turn_count ?? 0) === 0 &&
      !ABORT_END_ERROR_NAMES.includes(error?.name ?? '')
    ) {
      const cause = [error?.name, error?.message].filter(Boolean).join(': ');
      const { transitionSession } = await import('./session-lifecycle/status-transitions');
      await transitionSession('parkTurnError', sessionId, {
        error: (cause ? `agent turn failed: ${cause}` : 'agent turn failed').slice(0, 1000),
      });
    }
    return result;
  });
  const rows = normalizeRows(result);
  if (!rows || rows.length === 0) {
    return { outcome: 'no_active_turn', activeTurnCount: 0, closedTurnCount: 0 };
  }

  // The metadata entry is gone; the ledger row is not. `end_reason` is the only
  // record of HOW the turn ended once activeTurns has forgotten it existed.
  const owner = ledgerIdentity(rows?.[0]);
  const turns = endedLedgerTurns(rows?.[0]?.ended_turns);
  const activeTurnCount = Number(rows[0]?.active_turn_count ?? 0);
  const endError = endErrorRecord(status, error);
  if (turns.length === 0) {
    return settleAlreadyClosedTurn(sessionId, status, identity, endError, activeTurnCount);
  }
  if (owner && turns.length > 0) {
    const endReason: SessionTurnEndReason = status === 'error' ? 'failed' : 'completed';
    await recordTurnLedger(
      endedTurnLedger(owner, turns, endReason, endError),
      `complete ${turns.map((turn) => turn.token).join(',')} (${endReason})`,
    );
    // The backstop for an acceptance that never landed: `completed`/`failed`
    // both mean the turn RAN, so the prompt it carried is consumed either way.
    // The never-ran reasons (`abandoned`, `runtime_gone`, `unknown`) cannot
    // reach here — this path only ever writes the two — which is what keeps
    // this from racing `requeueAbandonedPrompt`, the owner of exactly those.
    for (const turn of turns) {
      await confirmInboxPromptConsumed(owner.sessionId, turn.messageId);
    }
  }
  return {
    outcome: 'closed',
    activeTurnCount,
    closedTurnCount: turns.length,
  };
}

/**
 * Close ONE open turn by the user message it was opened for — exact match only,
 * no fallback to an unkeyed record — and write its ledger end with `reason`.
 *
 * For prompts forwarded INTO a live turn: their records are opened per
 * message and the daemon's `end` relay names only the message the FINAL
 * assistant answered, so every other forwarded record of that turn would stay
 * open until a reaper sweep gave up on it (~20 s of "working" after the last
 * answer). `session-lifecycle/forwarded-strand-reconcile.ts` closes the ones
 * the step answered with `completed`, and the ones it stranded with
 * `abandoned` once they are re-queued; `inbox-hold-settle.ts` closes the ones
 * a Stop took back out of the transcript with `abandoned` too.
 *
 * Does NOT confirm inbox consumption: the callers decide what the row becomes.
 * Returns true when a record was closed.
 */
export async function closeSandboxTurnByMessageId(
  sessionId: string,
  messageId: string,
  reason: SessionTurnEndReason,
  graceMs = idleGraceMs(),
): Promise<boolean> {
  const result = await execute(sql`
    WITH target AS (${sandboxTurnTargetCte(sessionId)})
    , selected AS (
      SELECT target.sandbox_id,
             entry.key,
             entry.value->>'token' AS token,
             entry.value
        FROM target
        CROSS JOIN LATERAL ${activeTurnEntries(sql`target.metadata`)}
       WHERE entry.value->>'state' IN ('delivering', 'active')
         AND entry.value->>'messageId' = ${messageId}
    ), next_state AS (${removeAndReturnTurns()}
       WHERE EXISTS (SELECT 1 FROM selected WHERE selected.sandbox_id = target.sandbox_id)
    )
    UPDATE kortix.session_sandboxes s
       SET metadata = next_state.metadata,
           deadline_at = ${contractIdleDeadline(sql`next_state.metadata`, graceMs)},
           updated_at = now()
      FROM next_state
     WHERE s.sandbox_id = next_state.sandbox_id
    RETURNING next_state.ended_turns, s.session_id, s.sandbox_id, s.project_id, s.account_id`);
  const rows = normalizeRows(result);
  const owner = rows?.[0] ? ledgerIdentity(rows[0]) : null;
  const turns = endedLedgerTurns(rows?.[0]?.ended_turns);
  if (owner && turns.length > 0) {
    await recordTurnLedger(
      endedTurnLedger(owner, turns, reason),
      `close-by-message ${turns.map((turn) => turn.token).join(',')} (${reason})`,
    );
  }
  // The ledger row may still be open with its metadata entry already gone
  // (settled by a renewal/acceptance pass that never named this message):
  // close it directly, by the message it was opened for. Observation, never
  // authority — a failed write is logged and the reaper's backstop closes it.
  let closedLedger = false;
  try {
    const direct = await execute(sql`UPDATE kortix.session_turns
         SET state = 'ended', end_reason = ${reason}, ended_at = now(), updated_at = now()
       WHERE session_id = ${sessionId}
         AND message_id = ${messageId}
         AND state <> 'ended'
       RETURNING turn_token`);
    closedLedger = (normalizeRows(direct)?.length ?? 0) > 0;
  } catch (error) {
    console.warn(
      `[turn-ledger] close-by-message ledger write failed for ${messageId}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return turns.length > 0 || closedLedger;
}

/**
 * Renew one accepted turn after the reaper observes that exact OpenCode turn in
 * flight. The token CAS prevents stale evidence from renewing a newer turn.
 */
export async function renewActiveSandboxTurn(
  sandboxId: string,
  token: string,
  grantMs = turnGrantMs(),
): Promise<ActiveTurnRenewal> {
  const result = await execute(sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = GREATEST(
             s.deadline_at,
             now() + make_interval(secs => ${secs(grantMs)})),
           updated_at = now()
     WHERE s.sandbox_id = ${sandboxId}::uuid
       AND s.status = 'active'
       AND s.metadata->'activeTurns'->${token}->>'token' = ${token}
       AND s.metadata->'activeTurns'->${token}->>'state' = 'active'
    RETURNING true AS renewed`);
  const rows = normalizeRows(result);
  if (!rows?.length) return 'inactive';
  return 'renewed';
}
