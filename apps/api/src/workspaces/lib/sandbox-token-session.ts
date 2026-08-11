/**
 * A sandbox token acts for exactly one session.
 *
 * `sandbox_id == session_id` by construction (session-sandbox.ts mints the
 * token bound to the sandbox it provisions), so any request carrying a
 * caller-supplied `session_id` under a sandbox token must target that token's
 * OWN session — never a sibling in the same project.
 *
 * `POST /turn-question` scoped the caller-supplied `session_id` to the workspace
 * only, so one sandbox could finalize and repost another session's live turn.
 * The sibling `turn-stream` already gets this right; this makes the invariant a
 * named, tested function so no third route relearns it wrong.
 */
export function sandboxTokenMayActOnSession(
  tokenSandboxId: string | null | undefined,
  requestedSessionId: string,
): boolean {
  if (!tokenSandboxId) return false;
  return tokenSandboxId === requestedSessionId;
}
