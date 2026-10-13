// Migration: pending_questions_close_stale  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: open kortix.session_pending_questions rows, 500 per batch.
// Bounds measured read-only on 2026-10-13 (open rows / rows this pass closes):
// prod 1,093 / 518, dev 75 / 40, staging 1 match. The selection takes 0.3 s on
// prod. A closed row leaves the selection (answered_at is set), so the loop
// ends when a batch changes nothing.
//
// KRTX-1739 (#9772) closes a stored agent question when the wait ends, and the
// web and mobile session lists read every open question as "Needs you". Rows
// written before #9772 stayed open after their wait ended. This pass closes the
// rows the new rules would have closed (projects/lib/pending-questions.ts
// `clearOpenQuestions` and its callers):
//
// 1. A later turn started in the session. A delivered prompt closes the
//    questions asked before it (queued-continue-delivery.ts, `askedBefore`).
// 2. The turn that asked ended idle (`completed`) or by a stop or an abort
//    (session-turn-ledger.ts REQUESTED_STOP_NAMES, ABORT_END_ERROR_NAMES).
//    `settleTurnEnd` closes the questions on a turn end that closed the turn.
//
// It leaves open:
// - a question whose turn is still open, or parked on `TurnAwaitingInput`;
// - a turn the server ended (runtime_gone, abandoned, unknown): a stored
//   question survives its box, and its answer starts a follow-up turn;
// - any other `failed` end: the ledger records a daemon failure and a server
//   cause (`SandboxStoppedMidTurn`, `TurnAwaitingInput`) under the same
//   end_reason, so this pass does not guess;
// - a question with no turn row (asked before the turn ledger existed).
//
// answers stays null, as on every close the API writes. Row locks only; the
// house 5s lock budget keeps writers from queueing behind a batch.

export const shorthands = undefined;

const BATCH = 500;
// A bound, not an expectation: every batch shrinks its own selection.
const MAX_BATCHES = 10000;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the batches below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { rowCount } = await pgm.db.query(`
      update kortix.session_pending_questions pq
         set answered_at = now(),
             updated_at = now()
       where pq.id in (
         select q.id
           from kortix.session_pending_questions q
          where q.answered_at is null
            and (
              exists (
                select 1
                  from kortix.session_turns later
                 where later.session_id = q.session_id
                   and later.started_at > q.asked_at
              )
              or exists (
                select 1
                  from (
                    select own.state, own.end_reason, own.end_error
                      from kortix.session_turns own
                     where own.session_id = q.session_id
                       and own.started_at <= q.asked_at
                     order by own.started_at desc
                     limit 1
                  ) asking
                 where asking.state = 'ended'
                   and (
                     asking.end_reason = 'completed'
                     or asking.end_error->>'name' in
                       ('UserStop', 'QueueInterrupt', 'MessageAbortedError', 'AbortError')
                   )
              )
            )
          limit ${BATCH}
       )
    `);
    if (!rowCount) return;
  }
  throw new Error('pending_questions_close_stale: batch bound reached');
};

export const down = false;
