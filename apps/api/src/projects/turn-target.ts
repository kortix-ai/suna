/**
 * WHICH ROW A TURN RECORD IS WRITTEN INTO.
 *
 * `activeTurns` lives in `session_sandboxes.metadata`, and the turn-lifecycle
 * writes accept a target of `{sandboxId}`, `{sessionId}` or `{externalId}`.
 * `{externalId}` was a fine way to say "this session's box" while a box held one
 * session. A CELL SANDBOX HOLDS MANY, and `s.external_id = $1` then matches
 * every session on it, so one session's turn record is written into all of
 * their rows.
 *
 * MEASURED on dev 2026-09-09 with the shared host on: two different sessions
 * held the byte-identical set of five `active` records, including records whose
 * `opencodeSessionId` belonged to neither of them. Since a queued prompt waits
 * while any record is open, one session's unfinished turn blocked every other
 * session on that box behind `turn_active` — a session that simply never
 * answers.
 *
 * This is the third defect of that shape, after the transcript root and the
 * session token. The rule they share: anything keyed by `external_id` that
 * describes a SESSION is wrong the moment a box carries more than one.
 */

export type TurnTarget = { sessionId: string } | { externalId: string };

/**
 * Target the SESSION when it is known, the box only when it is not.
 *
 * Pure, so both branches are asserted rather than reproduced with two sessions
 * on one sandbox. The fallback is deliberate rather than defensive: a caller
 * that genuinely has no session (an orphan box being reconciled) still needs to
 * address something, and for a box with one session the two are identical.
 */
export function turnTargetFor(
  sessionId: string | null | undefined,
  externalId: string,
): TurnTarget {
  const id = sessionId?.trim();
  return id ? { sessionId: id } : { externalId };
}
