/**
 * Changing the model a RUNNING session uses.
 *
 * `opencode_model` was create-only: the sandbox reads `KORTIX_OPENCODE_MODEL`
 * when it builds opencode's config at spawn, and nothing re-pushed it, so a live
 * box kept its boot-time model forever. Worse, the stored value was reachable
 * through `PATCH /sessions/{id}` metadata WITHOUT the create-time validation, so
 * a retired or account-forbidden model could be planted and would be booted by
 * the next cold provision.
 *
 * This module holds the pure parts so both paths agree on what a legal change is.
 */

/** Terminal states — there is no live agent to re-point, and a cold boot would
 *  re-read the row anyway, so a change here is meaningless rather than harmful. */
const UNCHANGEABLE_STATUSES = new Set(['failed', 'completed', 'stopped']);

export type ModelChangeRejection =
  | { code: 'INVALID_SESSION_MODEL'; message: string }
  | { code: 'SESSION_NOT_RUNNING'; message: string };

/**
 * Shape-check a requested model id. Deliberately NOT an allow-list — that is
 * `isModelServableForAccount`, which needs IO. This only rejects what can never
 * be a model id, so the caller gets a 400 instead of a dead turn later.
 */
export function validateModelChangeShape(requested: string): ModelChangeRejection | null {
  const trimmed = requested.trim();
  if (trimmed.length === 0) {
    return { code: 'INVALID_SESSION_MODEL', message: 'model must not be blank' };
  }
  if (/\s/.test(trimmed)) {
    return {
      code: 'INVALID_SESSION_MODEL',
      message: `"${requested}" doesn't look like a model id`,
    };
  }
  if (trimmed.length > 128) {
    return { code: 'INVALID_SESSION_MODEL', message: 'model id is too long' };
  }
  return null;
}

/**
 * May this session's model change right now?
 *
 * A queued/provisioning session is allowed: the row is what a cold boot reads,
 * so writing it early is correct and needs no live push. A terminal session is
 * refused — nothing would consume the value.
 */
export function canChangeSessionModel(status: string): ModelChangeRejection | null {
  if (UNCHANGEABLE_STATUSES.has(status)) {
    return {
      code: 'SESSION_NOT_RUNNING',
      message: `session is ${status} — its model can no longer change`,
    };
  }
  return null;
}

/**
 * Does this change require restarting opencode inside a live sandbox?
 *
 * Only when the value actually differs AND a box is up. Restarting opencode
 * costs the user their in-flight turn, so a no-op PUT must not do it.
 */
export function modelChangeNeedsLivePush(input: {
  current: string | null;
  next: string;
  status: string;
}): boolean {
  if (input.current === input.next) return false;
  return input.status === 'running';
}
