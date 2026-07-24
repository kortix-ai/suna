import type { SessionLifecycleResult } from './types';

/**
 * Cross-tenant idempotency guard.
 *
 * Idempotency keys are globally unique (the unique index on
 * `session_lifecycle_commands` is on `idempotency_key` ALONE), so a caller's key
 * can collide with a command that is NOT the caller's own create — a DIFFERENT
 * account's or a DIFFERENT project's row (a predictable channel key like
 * `telegram:<projectId>:<update_id>`, or two callers both using a low-entropy key
 * like `"1"`), or even a `continue_session` command sharing the key space.
 * Returning that conflicting command would leak the other tenant's session (id,
 * branch, prompt text, channel binding) or serialize a foreign project's session
 * to a caller who only has access to their own, so this rejects the collision
 * with a 409 that never echoes the foreign command's id.
 *
 * Returns `null` ONLY when the existing row is the caller's own `create_session`
 * for the SAME account AND project → fall through to the normal idempotent dedupe
 * (return the caller's own prior command/session).
 *
 * (A per-account composite unique index `(account_id, idempotency_key)` would let
 * each tenant reuse keys independently, but changing the `ON CONFLICT` target is
 * not rolling-deploy-safe — old pods target the key-only index — so we gate at
 * read time instead.)
 */
export function crossAccountIdempotencyResult(
  existing: { accountId: string; projectId: string; commandType: string },
  caller: { accountId: string; projectId: string },
): SessionLifecycleResult | null {
  const isCallersOwnCreate =
    existing.commandType === 'create_session' &&
    existing.accountId === caller.accountId &&
    existing.projectId === caller.projectId;
  if (isCallersOwnCreate) return null;
  return {
    status: 'failed',
    retryable: false,
    error: {
      status: 409,
      body: {
        error: 'Idempotency key is already in use',
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      },
    },
  };
}
