/**
 * BOUNDED SANDBOX LIFETIME — the grant intervals, as literals.
 *
 * NONE of these read process.env, and that is the single most important
 * property of this file. The 2026-06-24 regression that cost 78% of a week's
 * billed sandbox-hours was a one-line env-knob widening buried as item 3 of an
 * unrelated commit with zero tests. A knob that cannot be turned in prod cannot
 * be turned by accident in prod. constants.test.ts fails CI if a `process.env`
 * ever appears here, and pins every literal below.
 *
 * `ABSOLUTE_RUN_CAP_MS` is additionally duplicated in the DB CHECK
 * (packages/db/migrations/20260730090000003_sandbox_deadline_check.sql). The
 * duplication is deliberate — the schema must bound the value even when every
 * line of this application is wrong — and constants.test.ts reads that file and
 * asserts the two agree.
 */

/** SHORTEN path only. A headless cron turn that has demonstrably finished. */
export const TRIGGER_POST_TURN_GRACE_MS = 5 * 60_000;

/**
 * Floor anchor for a → active transition where nothing is known about pending
 * work. Reached only as a floor, so ~zero false-kill risk by construction.
 */
export const IDLE_GRACE_MS = 15 * 60_000;

/**
 * Boot anchor. MUST strictly dominate the runtime-readiness wait plus two
 * maintenance ticks: the row flips to `active` at provider-create, not at
 * usability, and `continueSession` then spends up to READY_DEADLINE_MS (5 min)
 * waiting for the runtime before it may deliver a prompt. A 5-minute deadline
 * racing a 5-minute readiness wait, with a 5-minute sweep as tiebreaker,
 * silently kills cold-boot trigger sessions. Asserted in constants.test.ts.
 *
 * Mirrored by the anchor-guard trigger's `interval '20 minutes'` floor.
 */
export const BOOT_GRACE_MS = 20 * 60_000;

/**
 * Interactive post-turn window. SHORTEN path only, so it can never race a boot.
 *
 * 30 rather than 15 minutes because today the idle stop never fires at all
 * (`metadata.idleObservedAt` is a real timestamp on 0 of 284 rows), so this is
 * a change from effectively-infinite, not "unchanged from today". 15 minutes
 * would stop the box on a user who reads a long answer and takes a call, and
 * their next prompt then rides the known-live first-prompt-dropped-on-restart
 * path.
 */
export const POST_TURN_GRACE_MS = 30 * 60_000;

/**
 * Replaces the UNBOUNDED `warm_session.state === 'available'` reaper exemption
 * with a number. That exemption `continue`d before `getStatus()`, so a warm box
 * never received `markComputeSessionAlive` — immortal box AND under-bill.
 */
export const WARM_POOL_TTL_MS = 45 * 60_000;

/**
 * Billing-side grace: how long we keep charging after the last CONTROL-PLANE
 * observation of liveness. Wants to be SMALL (stop charging quickly once we
 * lose sight of a box) — the opposite of what the provider's native timer
 * wants, which is why `providerAutoStopBackstopMinutes()` serving both is a
 * live bug. Not consumed here yet; the billing clamp is a later deploy.
 */
export const COMPUTE_LIVENESS_GRACE_MS = 60 * 60_000;

/**
 * Granted by observed progress (a billed LLM call, an ACP relay, a PTY frame).
 *
 * THE number that must not recreate 2026-06-24, when idleness was measured from
 * the last LLM call and went blind during long local tool runs. Measured
 * intra-session gaps between consecutive usage_events (7 days, n=53,441): p50
 * 0.13m, p90 0.70m, p99 7.63m, p99.9 120.5m. That statistic measures the wrong
 * quantity — an inter-usage gap spans turn boundaries, so its tail is human
 * think-time, not intra-turn silence — and MUST be recomputed from
 * turn-bounded gaps before enforcement is flipped on. Shadow mode is how.
 */
export const PROGRESS_GRANT_MS = 120 * 60_000;

/**
 * Granted at an observed prompt. Of 4,438 reconstructed turns over 30 days, 33
 * (0.74%) ran over 4h. The reconstruction splits a turn paused overnight on an
 * approval into two clusters, so it understates long turns — which is why the
 * pending-input relay grants this same ceiling rather than a progress grant.
 */
export const TURN_CEILING_MS = 240 * 60_000;

/**
 * THE CEILING. Mirrored by the DB CHECK; the two are pinned together in
 * constants.test.ts. Of 4,438 reconstructed turns, 2 (0.05%) exceeded 24h, and
 * a stop is non-destructive, so the cost of that 0.05% is one re-prompt.
 */
export const ABSOLUTE_RUN_CAP_MS = 24 * 3_600_000;

/**
 * What the provider's own auto-stop timer should be set to, once the in-box
 * `/kortix/health` touch that resets it every 60s is gone. Deliberately LARGER
 * than the control plane's own cap so it never races us and never kills a box
 * mid-tool-run — the provider timer sees only inbound traffic and is blind to
 * local work, which is exactly the 2026-06-24 failure mode.
 */
export const PROVIDER_NATIVE_AUTOSTOP_MS = 25 * 3_600_000;

/**
 * The required ordering, as data so the test can assert the chain rather than
 * re-typing it (a hand-copied chain drifts and then certifies nothing).
 */
export const LIFETIME_CONSTANT_ORDER: ReadonlyArray<readonly [string, number]> = [
  ['TRIGGER_POST_TURN_GRACE_MS', TRIGGER_POST_TURN_GRACE_MS],
  ['IDLE_GRACE_MS', IDLE_GRACE_MS],
  ['BOOT_GRACE_MS', BOOT_GRACE_MS],
  ['POST_TURN_GRACE_MS', POST_TURN_GRACE_MS],
  ['WARM_POOL_TTL_MS', WARM_POOL_TTL_MS],
  ['COMPUTE_LIVENESS_GRACE_MS', COMPUTE_LIVENESS_GRACE_MS],
  ['PROGRESS_GRANT_MS', PROGRESS_GRANT_MS],
  ['TURN_CEILING_MS', TURN_CEILING_MS],
  ['ABSOLUTE_RUN_CAP_MS', ABSOLUTE_RUN_CAP_MS],
  ['PROVIDER_NATIVE_AUTOSTOP_MS', PROVIDER_NATIVE_AUTOSTOP_MS],
];
