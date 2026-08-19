/**
 * A provider can continue to report `stopped` while start() is still changing
 * the VM state. Reconciliation must not convert that transitional observation
 * into a durable Kortix stop, because doing so closes the compute meter and
 * leaves a later provider-running VM recorded as stopped.
 */
export const RUNTIME_WAKE_GRACE_MS = 90_000;
// Covers Platinum's 120-second lifecycle call plus the 90-second provider-state
// confirmation window. The row remains stopped and unbilled for this lease.
export const RUNTIME_WAKE_LEASE_MS = 240_000;
// Covers the provider stop timeout while maintenance owns the late-start check.
export const RUNTIME_WAKE_CLEANUP_LEASE_MS = 180_000;
export const RUNTIME_WAKE_RETRY_COOLDOWN_MS = 120_000;
export const RUNTIME_WAKE_LATE_START_GUARD_MS = 15 * 60_000;
// Wake-poll cadence. A Platinum CoW resume reaches `running` in ~1.9s
// (measured 3/3: 1918/1906/2391ms), so a flat 1000ms poll spent up to a full
// second sitting on an already-running VM. The ramp checks early where the
// answer actually changes, then decays to the old flat second so a slow or
// stuck wake costs no more provider calls than before across the 90s grace.
const RUNTIME_WAKE_POLL_RAMP_MS = [150, 250, 400, 600] as const;
const RUNTIME_WAKE_POLL_MS = 1_000;

/** Delay before the (attempt+1)-th status re-check. */
export function runtimeWakePollDelayMs(attempt: number, steadyMs: number = RUNTIME_WAKE_POLL_MS): number {
  return RUNTIME_WAKE_POLL_RAMP_MS[attempt] ?? steadyMs;
}

export async function waitForRuntimeWakeRunning(
  getStatus: () => Promise<string>,
  opts: {
    graceMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const graceMs = Math.max(0, opts.graceMs ?? RUNTIME_WAKE_GRACE_MS);
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
  let scheduledMs = 0;
  for (let attempt = 0; ; attempt += 1) {
    const status = await getStatus().catch(() => 'unknown');
    if (status === 'running') return true;
    if (status === 'removed') return false;
    const delay = ramped ? runtimeWakePollDelayMs(attempt, steadyMs) : steadyMs;
    if (scheduledMs + delay >= graceMs) return false;
    scheduledMs += delay;
    await sleep(delay);
  }
}

export function runtimeWakeInProgress(
  metadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!metadata || typeof metadata.runtimeWakeId !== 'string') return false;
  if (typeof metadata.runtimeWakeStartedAt !== 'string') return false;
  const leaseExpiresAtMs =
    typeof metadata.runtimeWakeLeaseExpiresAt === 'string'
      ? Date.parse(metadata.runtimeWakeLeaseExpiresAt)
      : Number.NaN;
  if (Number.isFinite(leaseExpiresAtMs)) return now.getTime() <= leaseExpiresAtMs;
  const startedAtMs = Date.parse(metadata.runtimeWakeStartedAt);
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = now.getTime() - startedAtMs;
  return ageMs >= 0 && ageMs <= RUNTIME_WAKE_LEASE_MS;
}

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
