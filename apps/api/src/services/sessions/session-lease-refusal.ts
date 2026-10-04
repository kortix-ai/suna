/**
 * The refusal a SESSION credential gets when its sandbox is no longer
 * `provisioning`/`active`, and the caller-facing reason it maps to.
 *
 * WHY ITS OWN MODULE. Two unrelated modules need the same value:
 * `services/repositories/account-tokens.ts` produces it, and `services/llm-gateway/hooks.ts`
 * maps it to a message. Importing it from `account-tokens` would make every
 * test that mocks that module with a partial object fail to load the gateway
 * (`SyntaxError: Export named … not found`), and re-typing the string in both
 * places would let a reword in one silently restore the wrong error in the
 * other. A leaf module with no imports is safe to depend on from either side.
 *
 * WHY THE MAPPING EXISTS AT ALL. A session credential is authority for ONE
 * live sandbox: `validateAccountToken` refuses it the moment that sandbox row
 * leaves `provisioning`/`active`. Every path that parks a row mid-turn
 * therefore withdraws the credential of a box that is still running, and the
 * gateway answered `Invalid token` — which is false. The token is valid and
 * unexpired; its lease was withdrawn. Measured on a real dev session,
 * 2026-09-28: a turn died reporting `Invalid token` on a box whose daemon was
 * healthy, which sends whoever reads it to check API keys — the wrong system.
 */

/** Returned by `validateAccountToken` when a session's sandbox lease is gone. */
export const SESSION_LEASE_REFUSAL = 'Session token is not active';

/** What a caller is told instead. */
export const SESSION_LEASE_REFUSAL_MESSAGE =
  'This session is no longer running, so its credential was withdrawn. Start the session again.';

/**
 * The caller-facing reason for a token refusal, or null when there is no
 * better explanation than "unknown token".
 */
export function tokenRefusalReason(error: string | null | undefined): string | null {
  if (!error) return null;
  // The one refusal that is about the SANDBOX, not about the token.
  return error === SESSION_LEASE_REFUSAL ? SESSION_LEASE_REFUSAL_MESSAGE : null;
}
