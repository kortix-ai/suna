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
const RUNTIME_WAKE_POLL_MS = 1_000;

export async function waitForRuntimeWakeRunning(
  getStatus: () => Promise<string>,
  opts: {
    graceMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const graceMs = Math.max(0, opts.graceMs ?? RUNTIME_WAKE_GRACE_MS);
  const pollMs = Math.max(1, opts.pollMs ?? RUNTIME_WAKE_POLL_MS);
  const attempts = Math.max(1, Math.ceil(graceMs / pollMs));
  const sleep = opts.sleep ?? Bun.sleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getStatus().catch(() => 'unknown');
    if (status === 'running') return true;
    if (status === 'removed') return false;
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return false;
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
}): Promise<RuntimeWakeExecutionResult> {
  let status = await input.getStatus().catch(() => 'unknown');
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
