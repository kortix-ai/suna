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

/** The 200 body of `PUT /projects/:p/sessions/:s/model`. */
export interface ModelChangeResult {
  opencode_model: string;
  /** True only when a live sandbox took the new model NOW. */
  applied_live: boolean;
  /**
   * Set (and only ever `true`) when a live push was REQUIRED and FAILED: the row
   * is written but the running harness is still on the old model.
   *
   * `applied_live: false` alone cannot carry this. It is also the ordinary,
   * benign answer for a cold session, where the row IS the whole mechanism and
   * the next boot reads it. Collapsing the two is what let the reference app
   * report `toast.success('… saved — applies when this session next starts')`
   * after a `502 upstream-closed-before-headers` env sync — a running session
   * that keeps answering from the OLD model, with the user told it changed.
   *
   * Kept as a 200 deliberately. The write DID happen and is durable; a non-2xx
   * would say it did not, and every client would retry a store that already
   * succeeded (or worse, treat the stored model as unset). The half-applied
   * state is a partial success, so it is reported as one — and this flag is what
   * makes it machine-checkable instead of a `detail` string clients must sniff.
   */
  push_failed?: true;
  detail?: string;
}

/**
 * Shape the response for a completed model write. Single source of truth for the
 * applied / stored / half-applied distinction, so the route and every client
 * agree on which of the three happened.
 */
export function modelChangeResult(input: {
  model: string;
  needsPush: boolean;
  push?: { applied: boolean; reason?: string };
  current?: string | null;
}): ModelChangeResult {
  if (!input.needsPush) {
    return {
      opencode_model: input.model,
      applied_live: false,
      detail:
        input.current === input.model
          ? 'already set to this model'
          : 'stored — applies when the sandbox next starts',
    };
  }
  if (input.push?.applied) {
    return { opencode_model: input.model, applied_live: true };
  }
  return {
    opencode_model: input.model,
    applied_live: false,
    push_failed: true,
    detail: `stored, but not pushed: ${input.push?.reason ?? 'unknown'}`,
  };
}

/**
 * May this caller CHANGE the session's model?
 *
 * Being able to SEE a session is not permission to mutate it. A
 * `visibility: 'project'` session is readable by every workspace member, but
 * changing its model restarts opencode and destroys the owner's in-flight turn
 * — so this gates on the same owner-or-manager signal the sharing and stop
 * routes use (r7.ts:1508, :1689) rather than on visibility.
 */
export function mayChangeSessionModel(visible: { canManageSharing: boolean }): boolean {
  return visible.canManageSharing;
}
