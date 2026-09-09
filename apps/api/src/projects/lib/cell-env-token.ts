/**
 * WHICH TOKEN GETS WRITTEN INTO A CELL, which is not the token used to reach it.
 *
 * `repairCellSessionEnv` does two things with one credential: it authenticates
 * the push to the sandbox, and it puts a `KORTIX_TOKEN` inside the cell for the
 * agent to speak with. Those are different questions the moment a box holds
 * more than one session.
 *
 * The prompt path resolves `serviceKeyForExternalId(externalId)` — "a key that
 * reaches this box" — and that key belongs to whichever session created it. On
 * a shared cell host it was then written into EVERY session's cell, so every
 * session but one spoke with a stranger's authority. Measured on dev
 * 2026-09-09, four sessions on sbx_01M21XGVJNB5TZE6SV8MRC8FMW:
 *
 *   the cell's own relay                 POST /turn-stream  403
 *   the same call, session's stored key  POST /turn-stream  200
 *
 * A refused `turn_end` leaves the ledger record open, so the next prompt on
 * that session waits behind `turn_active` and the session appears to hang. It
 * is the fourth defect of the shape "state keyed by external_id that describes
 * a SESSION", after the transcript root, the session token and the turn ledger.
 *
 * Pure so both branches are asserted rather than reproduced with two sessions
 * on one box. The box key remains the fallback deliberately: for a box with one
 * session the two are the same value, and a session whose own key cannot be
 * read is better off with a token that reaches the control plane than with
 * none at all.
 */
export function cellEnvToken(
  sessionKey: string | null | undefined,
  boxKey: string | null | undefined,
): string | null {
  const session = sessionKey?.trim();
  if (session) return session;
  const box = boxKey?.trim();
  return box ? box : null;
}
