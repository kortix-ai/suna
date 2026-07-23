import type { SessionLifecycleResult } from './types';

/**
 * Cross-tenant idempotency guard.
 *
 * Idempotency keys are globally unique (the unique index on
 * `session_lifecycle_commands` is on `idempotency_key` ALONE), so a caller's key
 * can collide with a DIFFERENT account's `create_session` command — e.g. a
 * predictable channel key (`telegram:<projectId>:<update_id>`) or two tenants
 * both using a low-entropy key like `"1"`. Returning the conflicting command
 * would leak the other tenant's session (id, branch, prompt text, channel
 * binding), so this rejects the collision with a 409 and never echoes the
 * foreign command's id.
 *
 * Same-account reuse returns `null` → fall through to the normal idempotent
 * dedupe (return the caller's own prior command/session).
 *
 * (A per-account composite unique index `(account_id, idempotency_key)` would let
 * each tenant reuse keys independently, but changing the `ON CONFLICT` target is
 * not rolling-deploy-safe — old pods target the key-only index — so we gate at
 * read time instead.)
 */
export function crossAccountIdempotencyResult(
  existingAccountId: string,
  callerAccountId: string,
): SessionLifecycleResult | null {
  if (existingAccountId === callerAccountId) return null;
  return {
    status: 'failed',
    retryable: false,
    error: {
      status: 409,
      body: {
        error: 'Idempotency key was already used by a different account',
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      },
    },
  };
}
