/**
 * A provider can continue to report `stopped` while start() is still changing
 * the VM state. Reconciliation must not convert that transitional observation
 * into a durable Kortix stop, because doing so closes the compute meter and
 * leaves a later provider-running VM recorded as stopped.
 */
export const RUNTIME_WAKE_GRACE_MS = 90_000;
// Covers Platinum's 120-second lifecycle call plus the 90-second provider-state
// confirmation window. The row remains stopped and unbilled for this lease.
// EXTENDED ON PROGRESS, never on wall clock: `runtimeWakeProgressPatch` writes a
// fresh expiry whenever the provider reports a state it had not reported before.
export const RUNTIME_WAKE_LEASE_MS = 240_000;
/**
 * Absolute ceiling on ONE wake, progress or not.
 *
 * The per-observation budgets above restart whenever the provider's answer
 * changes; this one never does, so a provider that flaps between two states
 * forever is still bounded and nothing downstream stays fenced off.
 *
 * Same shape as `STALE_OPENCODE_BOOT_HARD_MS` (readiness-clocks.ts) and for the
 * same reason — see the learning "A boot budget measures lack of progress, not
 * wall-clock".
 */
export const RUNTIME_WAKE_HARD_MS = 10 * 60_000;
// Covers the provider stop timeout while maintenance owns the late-start check.
export const RUNTIME_WAKE_CLEANUP_LEASE_MS = 180_000;
/**
 * The FIRST retry cooldown. Superseded as a standalone knob by
 * `RUNTIME_START_RETRY_BACKOFF_MS`, whose first entry is this value; kept so
 * the number has one name and rows written before the escalating ladder read
 * the same way.
 */
export const RUNTIME_WAKE_RETRY_COOLDOWN_MS = 120_000;
export const RUNTIME_WAKE_LATE_START_GUARD_MS = 15 * 60_000;
// Wake-poll cadence. A Platinum CoW resume reaches `running` in ~1.9s
// (measured 3/3: 1918/1906/2391ms), so a flat 1000ms poll spent up to a full
// second sitting on an already-running VM. The ramp checks early where the
// answer actually changes, then decays to the old flat second so a slow or
// stuck wake costs no more provider calls than before across the 90s grace.
const RUNTIME_WAKE_POLL_RAMP_MS = [150, 250, 400, 600] as const;
const RUNTIME_WAKE_POLL_MS = 1_000;
// Cadence PAST the no-progress grace. A wake that is still running after 90s is
// a slow provider (an E2B resume during a template build storm took 14m11s on
// 2026-08-26), not a wake anybody is watching second by second. Polling it at
// 1s for the whole hard cap would cost 600 provider calls; 5s costs ~102.
const RUNTIME_WAKE_SLOW_POLL_MS = 5_000;

/** Delay before the (attempt+1)-th status re-check. */
export function runtimeWakePollDelayMs(attempt: number, steadyMs: number = RUNTIME_WAKE_POLL_MS): number {
  return RUNTIME_WAKE_POLL_RAMP_MS[attempt] ?? steadyMs;
}

export async function waitForRuntimeWakeRunning(
  getStatus: () => Promise<string>,
  opts: {
    /** Budget WITHOUT a provider-state change. Restarts on every change. */
    graceMs?: number;
    /** Absolute ceiling on this wait, progress or not. */
    hardCapMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Called once per DISTINCT provider status this loop observes, in order.
     * The caller uses it to make the durable wake lease progress-aware; a
     * throw is swallowed, because persistence must never end a live wake.
     */
    onProgress?: (status: string) => void | Promise<void>;
  } = {},
): Promise<boolean> {
  const graceMs = Math.max(0, opts.graceMs ?? RUNTIME_WAKE_GRACE_MS);
  const hardCapMs = Math.max(graceMs, opts.hardCapMs ?? RUNTIME_WAKE_HARD_MS);
  // An explicit pollMs pins the cadence flat (tests, and any caller that wants
  // the old behaviour); otherwise the ramp above runs.
  const steadyMs = Math.max(1, opts.pollMs ?? RUNTIME_WAKE_POLL_MS);
  const ramped = opts.pollMs === undefined;
  const sleep = opts.sleep ?? Bun.sleep;

  // The budget counts the delays this loop ITSELF schedules, not wall-clock.
  // With a variable delay an attempt count is no longer a stand-in for the
  // grace, but reading a clock instead would make the loop spin under an
  // injected no-op sleep. Accumulating the scheduled delay is deterministic
  // under a fake sleep and reduces to the old `ceil(grace / poll)` attempt
  // count exactly when the cadence is flat.
  //
  // TWO budgets, per the boot-budget learning: `graceMs` bounds time WITHOUT
  // progress and restarts whenever the provider answers something new;
  // `hardCapMs` bounds the whole wait and never restarts. A wake that keeps
  // advancing is no longer killed at 90s for being slow — 2026-08-26, session
  // e06ad0c4: the box reached ready 10s after the fixed budget gave up on it.
  let scheduledMs = 0;
  let scheduledAtLastProgress = 0;
  let lastStatus: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    const status = await getStatus().catch(() => 'unknown');
    if (status === 'running') return true;
    if (status === 'removed') return false;
    if (status !== lastStatus) {
      lastStatus = status;
      scheduledAtLastProgress = scheduledMs;
      try {
        await opts.onProgress?.(status);
      } catch {
        // A lease-extension write that fails costs this wake its extension,
        // never the wake itself.
      }
    }
    const rampedDelay =
      scheduledMs >= graceMs ? Math.max(steadyMs, RUNTIME_WAKE_SLOW_POLL_MS) : steadyMs;
    const delay = ramped ? runtimeWakePollDelayMs(attempt, rampedDelay) : steadyMs;
    if (scheduledMs + delay - scheduledAtLastProgress >= graceMs) return false;
    if (scheduledMs + delay >= hardCapMs) return false;
    scheduledMs += delay;
    await sleep(delay);
  }
}

/**
 * The metadata patch that records provider PROGRESS during a claimed wake, or
 * null when the provider answered the same thing as last time.
 *
 * Progress refreshes the lease. `runtimeWakeInProgress` — and therefore the
 * reconcile gate in reaping/sandbox-state-sync.ts, the box reaper's
 * `reconcile-stopped` skip, and the compute-close policy — is what consumes it,
 * so a wake that is visibly advancing keeps its fence and a wedged one loses it
 * on the ORIGINAL 240s schedule. `runtimeWakeStartedAt` is never moved: it feeds
 * the hard cap.
 */
export function runtimeWakeProgressPatch(
  metadata: Record<string, unknown> | null | undefined,
  providerStatus: string,
  now: Date = new Date(),
): Record<string, unknown> | null {
  if (!metadata || typeof metadata.runtimeWakeId !== 'string') return null;
  const previous =
    typeof metadata.runtimeWakeProviderStatus === 'string'
      ? metadata.runtimeWakeProviderStatus
      : null;
  if (previous === providerStatus) return null;
  return {
    runtimeWakeProviderStatus: providerStatus,
    runtimeWakeProgressAt: now.toISOString(),
    runtimeWakeLeaseExpiresAt: new Date(now.getTime() + RUNTIME_WAKE_LEASE_MS).toISOString(),
  };
}

export function runtimeWakeInProgress(
  metadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!metadata || typeof metadata.runtimeWakeId !== 'string') return false;
  if (typeof metadata.runtimeWakeStartedAt !== 'string') return false;
  const startedAtMs = Date.parse(metadata.runtimeWakeStartedAt);
  // HARD CEILING, checked FIRST. The lease below is refreshed by
  // `runtimeWakeProgressPatch`, so without this a provider whose status flaps
  // could hold the reconcile gate — and with it the compute-close policy's
  // `wakeInProgress` exemption — open indefinitely. The gate must expire.
  if (Number.isFinite(startedAtMs) && now.getTime() - startedAtMs > RUNTIME_WAKE_HARD_MS) {
    return false;
  }
  const leaseExpiresAtMs =
    typeof metadata.runtimeWakeLeaseExpiresAt === 'string'
      ? Date.parse(metadata.runtimeWakeLeaseExpiresAt)
      : Number.NaN;
  if (Number.isFinite(leaseExpiresAtMs)) return now.getTime() <= leaseExpiresAtMs;
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = now.getTime() - startedAtMs;
  return ageMs >= 0 && ageMs <= RUNTIME_WAKE_LEASE_MS;
}

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Stamped runtime-start failures: a COOLDOWN, never a gravestone.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Incident 2026-08-26 (Essentia): session e06ad0c4 answered `/start` with
 * `stage:'failed'` in 47ms — no provider call — because a wake that ran out of
 * its FIXED 240s budget had stamped `stopReason:'runtime_wake_failed'` on the
 * row. Session 9c8749ac replayed the same dead end for 10+ hours from a
 * `runtime_boot_failed` stamp written at 03:37Z. Both boxes were startable; the
 * human's one click on Restart always worked, because `POST /restart` is the
 * only thing that ever cleared the stamp.
 *
 * Two stop reasons produce that replay and both are covered here. The rule they
 * now obey:
 *
 *   1. A stamped failure suppresses re-attempts for a COOLDOWN, which escalates
 *      with consecutive failures so a broken provider is not hammered.
 *   2. After the cooldown, the next `/start` RE-ATTEMPTS. There is no state a
 *      session can reach where only a human can ask again.
 *   3. A verdict outlives neither its evidence (`RUNTIME_START_FAILURE_TTL_MS`)
 *      nor its budget (`RUNTIME_START_MAX_FAILURES` consecutive failures earn a
 *      terminal card that names the attempts — and that card, too, expires).
 */
export const STAMPED_RUNTIME_FAILURE_STOP_REASONS = [
  'runtime_wake_failed',
  'runtime_boot_failed',
] as const;

/**
 * Wake errors a re-attempt cannot answer. `missing` is the provider's own
 * "this box does not exist" — the runtime-identity paths own that verdict, and
 * re-asking a provider that has disowned the box buys nothing.
 */
const TERMINAL_RUNTIME_WAKE_ERRORS = new Set(['missing']);

/** Cooldown per consecutive failure. The last entry repeats. */
export const RUNTIME_START_RETRY_BACKOFF_MS = [120_000, 300_000, 600_000] as const;
/** Consecutive failures that earn a terminal card instead of another attempt. */
export const RUNTIME_START_MAX_FAILURES = 5;
/**
 * How long a stamped failure remains EVIDENCE about now.
 *
 * A verdict older than this describes a visit that is over. Replaying it is the
 * 10-hour dead end itself, so past the TTL the next `/start` re-attempts from a
 * clean slate — including a terminal one, because "the provider had lost this
 * box half an hour ago" is not an observation about the present.
 */
export const RUNTIME_START_FAILURE_TTL_MS = 30 * 60_000;

export type StampedRuntimeFailureState = 'cooling_down' | 'retry' | 'terminal';

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cooldown owed after `failureCount` consecutive failures (1-based). */
export function runtimeStartRetryDelayMs(failureCount: number): number {
  const index =
    Math.min(Math.max(1, Math.trunc(failureCount) || 1), RUNTIME_START_RETRY_BACKOFF_MS.length) - 1;
  return RUNTIME_START_RETRY_BACKOFF_MS[index];
}

/** Consecutive runtime-start failures recorded on this row (>= 1 once stamped). */
export function runtimeStartFailureCount(
  metadata: Record<string, unknown> | null | undefined,
): number {
  const raw = metadata?.runtimeStartFailureCount;
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** When the stamped failure happened, from the newest clock the row carries. */
export function runtimeStartFailedAtMs(
  metadata: Record<string, unknown> | null | undefined,
): number | null {
  return (
    parseMs(metadata?.runtimeStartFailedAt) ??
    parseMs(metadata?.runtimeWakeFailedAt) ??
    parseMs(metadata?.stoppedAt)
  );
}

/** When the server may re-attempt, or null when the row carries no clock. */
export function runtimeStartRetryAtMs(
  metadata: Record<string, unknown> | null | undefined,
  failedAtMs = runtimeStartFailedAtMs(metadata),
): number | null {
  const explicit =
    parseMs(metadata?.runtimeStartRetryAfterAt) ?? parseMs(metadata?.runtimeWakeRetryAfterAt);
  if (explicit !== null) return explicit;
  if (failedAtMs === null) return null;
  return failedAtMs + runtimeStartRetryDelayMs(runtimeStartFailureCount(metadata));
}

/**
 * What a row carrying a stamped runtime-start failure is owed on THIS `/start`:
 * a re-attempt, a cooldown, or a terminal answer. `null` = no stamp.
 */
export function stampedRuntimeFailureState(
  metadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): StampedRuntimeFailureState | null {
  if (!metadata) return null;
  const stopReason = metadata.stopReason;
  if (
    typeof stopReason !== 'string' ||
    !(STAMPED_RUNTIME_FAILURE_STOP_REASONS as readonly string[]).includes(stopReason)
  ) {
    return null;
  }
  const failedAtMs = runtimeStartFailedAtMs(metadata);
  // A stamp with no readable clock can never expire, and a verdict that cannot
  // expire is exactly the dead end this function exists to remove.
  if (failedAtMs === null) return 'retry';
  const ageMs = now.getTime() - failedAtMs;
  if (ageMs >= RUNTIME_START_FAILURE_TTL_MS) return 'retry';
  // Clock skew ahead of us is not permission to hammer the provider.
  if (ageMs < 0) return 'cooling_down';
  if (
    typeof metadata.runtimeWakeError === 'string' &&
    TERMINAL_RUNTIME_WAKE_ERRORS.has(metadata.runtimeWakeError)
  ) {
    return 'terminal';
  }
  if (runtimeStartFailureCount(metadata) >= RUNTIME_START_MAX_FAILURES) return 'terminal';
  const retryAtMs = runtimeStartRetryAtMs(metadata, failedAtMs);
  if (retryAtMs === null) return 'retry';
  return now.getTime() < retryAtMs ? 'cooling_down' : 'retry';
}

/**
 * The metadata patch that records ONE runtime-start failure: the consecutive
 * count, when it happened, and when the server may try again.
 *
 * The count resets once the previous failure is older than the TTL, so
 * "consecutive" means "inside one episode", not "since this row was created".
 * `runtimeWakeRetryAfterAt` is written alongside because
 * `resumeStoppedSandbox`'s claim CAS already reads that key.
 */
export function runtimeStartFailurePatch(
  metadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): Record<string, unknown> {
  const previousAtMs = runtimeStartFailedAtMs(metadata);
  const consecutive =
    previousAtMs !== null && now.getTime() - previousAtMs < RUNTIME_START_FAILURE_TTL_MS
      ? runtimeStartFailureCount(metadata) + 1
      : 1;
  const retryAfterAt = new Date(now.getTime() + runtimeStartRetryDelayMs(consecutive)).toISOString();
  return {
    runtimeStartFailureCount: consecutive,
    runtimeStartFailedAt: now.toISOString(),
    runtimeStartRetryAfterAt: retryAfterAt,
    runtimeWakeRetryAfterAt: retryAfterAt,
  };
}

/** Keys a successful start must drop so the next failure counts from one. */
export const RUNTIME_START_FAILURE_KEYS = [
  'runtimeStartFailureCount',
  'runtimeStartFailedAt',
  'runtimeStartRetryAfterAt',
] as const;

/**
 * Legacy predicate: "is `runtimeWakeRetryAfterAt` still in the future?".
 * `stampedRuntimeFailureState` replaced it on the `/start` path because a bare
 * cooldown check cannot tell a re-attemptable failure from a terminal one, and
 * answering only that question is what produced the 10-hour replay. Kept for
 * callers that want the raw clock.
 */
export function runtimeWakeRetryCoolingDown(
  metadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): boolean {
  const value = metadata?.runtimeWakeRetryAfterAt;
  if (typeof value !== 'string') return false;
  const retryAtMs = Date.parse(value);
  return Number.isFinite(retryAtMs) && retryAtMs > now.getTime();
}

export function isAmbiguousRuntimeStartError(error: unknown): boolean {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    name.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('aborted') ||
    message.includes('connection reset')
  );
}

export type RuntimeWakeExecutionResult = 'running' | 'failed' | 'cancelled' | 'delegated';

/**
 * Provider-facing half of a claimed wake. Persistence stays injected so the
 * state machine is testable without a database and every money mutation remains
 * in the caller's provider-confirmed `finalize` callback.
 */
export async function executeClaimedRuntimeWake(input: {
  getStatus: () => Promise<string>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  finalize: () => Promise<boolean>;
  fail: (reason: string) => Promise<boolean>;
  claimState: () => Promise<'owned' | 'delegated' | 'cancelled'>;
  isMissingError?: (error: unknown) => boolean;
  waitOptions?: Parameters<typeof waitForRuntimeWakeRunning>[1];
  /**
   * A provider status the caller ALREADY paid a round trip for, reused here
   * instead of asking again.
   *
   * `openSession` reads `provider.getStatus()` immediately before claiming the
   * wake (it has to: a `removed` box needs backup restoration, not a start).
   * Re-reading it here cost a second full provider round trip on the critical
   * path of every resume — measured ~0.5s against Platinum from the dev API,
   * for an answer taken microseconds earlier. The status can only have gone
   * stale in the caller's favour: a box that became `running` in that window is
   * started again (idempotent, and the adapter already handles the 409), and a
   * box that stopped harder is still started. Omit it and the pre-check runs as
   * before.
   */
  knownStatus?: string | null;
}): Promise<RuntimeWakeExecutionResult> {
  let status = input.knownStatus ?? (await input.getStatus().catch(() => 'unknown'));
  let startError: unknown = null;

  if (status !== 'running' && status !== 'removed') {
    try {
      await input.start();
    } catch (error) {
      startError = error;
      if (!isAmbiguousRuntimeStartError(error)) {
        await input.fail(input.isMissingError?.(error) ? 'missing' : 'start_failed');
        return 'failed';
      }
    }
    const postStartClaim = await input.claimState();
    if (postStartClaim === 'delegated') return 'delegated';
    if (postStartClaim === 'cancelled') {
      await input.stop().catch(() => undefined);
      return 'cancelled';
    }
    const running = await waitForRuntimeWakeRunning(input.getStatus, input.waitOptions);
    status = running ? 'running' : status;
  }

  if (status === 'running') {
    const finalized = await input.finalize();
    if (finalized) return 'running';
    const claimState = await input.claimState();
    if (claimState === 'delegated') return 'delegated';
    await input.stop().catch(() => undefined);
    return 'cancelled';
  }

  const reason =
    status === 'removed' ? 'missing' : startError ? 'start_timeout' : 'provider_not_running';
  await input.fail(reason);
  return 'failed';
}
