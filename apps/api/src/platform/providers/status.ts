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
