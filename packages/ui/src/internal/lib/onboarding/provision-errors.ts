/**
 * Classifiers for the errors `POST /projects/provision` returns. The create
 * flow (`use-create-workspace.ts`) branches on them to pick the right message
 * and to decide whether a retry can help.
 */

export function isProjectLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('project_limit_reached') || message.includes('Free accounts are limited to')
  );
}

/**
 * True for the 503 `POST /projects/provision` returns when no managed-git
 * backend is configured (e.g. self-host with no MANAGED_GIT_* set) — an
 * EXPECTED, operator-fixable state, not a bug.
 *
 * Reads the message, never the status alone. The API's edge middleware
 * (`apps/api/src/index.ts`, EDGE_REWRITTEN_STATUSES) sends every 502 as a 503
 * with the body kept, so a bare 503 is also any upstream failure — GitHub's
 * `/user/repos` 403 on create-repo read as "managed git isn't set up" in prod.
 */
export function isManagedGitUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('is not configured on this server');
}

/**
 * True for the `409` `POST /projects/provision` returns when another call
 * carrying the SAME `idempotency_key` is mid-provision — see
 * `apps/api/src/projects/lib/provision-idempotency.ts`'s `in_flight` case.
 * This is a RETRYABLE state, not a terminal failure: the concurrent call's
 * outcome just isn't decided yet. Checks `code` first — the precise signal
 * the route sends — and falls back to the message for a caller that only has
 * a plain `Error` (matching `isManagedGitUnavailableError`'s pattern), scoped
 * to `409` so an unrelated conflict is never misread as this one.
 */
export function isProvisionInFlightError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  // The literal, not `PROVISION_IN_FLIGHT_CODE` from `@kortix/sdk`: this
  // module's own test suite replaces `@kortix/sdk` wholesale via `mock.module`,
  // so an imported constant would read back `undefined` there and make every
  // code-less error match. Kept in sync with the SDK constant by name.
  if (code === 'provision_in_flight') return true;
  const status = (err as { status?: number } | null)?.status;
  if (status !== 409) return false;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('idempotency_key is in flight');
}
