/**
 * The provider-agnostic sandbox status vocabulary.
 *
 * `terminal` is a box the provider reports in a DEAD, unrecoverable state
 * (Daytona `error`/`build_failed`, Platinum `failed`) — deliberately distinct
 * from `unknown`, which means "we could not determine the state right now".
 *
 * They were conflated until 2026-07-29, and that conflation was the single most
 * expensive bug in this subsystem: a dead box came back as `unknown`,
 * `decideReconcile('unknown')` returns 'none' by design, and so compute billing
 * accrued wall-clock against it in perpetuity (829 hours on the worst row).
 *
 * The two rules this split encodes:
 *   - uncertainty must NEVER authorize a kill;
 *   - uncertainty must ALWAYS stop the meter.
 *
 * Its own module so the type is importable by pure decision code (state maps,
 * policy functions) without dragging in the provider registry and its config.
 */
export type SandboxStatus = 'running' | 'stopped' | 'removed' | 'terminal' | 'unknown';

/**
 * The provider says the box (or the resource asked for) does not exist: an
 * HTTP 404, a `not_found` code, or an SDK not-found class. Never the message
 * text — a 500 whose body says "not found" is not a lost computer.
 */
export function isProviderNotFound(error: unknown): boolean {
  const err = error as
    | { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown }
    | null
    | undefined;
  if (err?.name === 'DaytonaNotFoundError' || err?.name === 'SandboxNotFoundError') return true;
  if (err?.status === 404 || err?.statusCode === 404 || err?.code === 404) return true;
  const code = typeof err?.code === 'string' ? err.code.toLowerCase() : '';
  return code === 'not_found' || code === 'notfound';
}
