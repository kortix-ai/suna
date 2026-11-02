import { SnapshotStillBuildingError, WarmRuntimeUnavailableError, SandboxTemplateNotFoundError } from '../providers';
import type { CreateSandboxOpts, ProvisionResult, SandboxProvider } from '../providers';
import { classifySandboxProvisioningFailure } from './sandbox-provisioning-error';
import { exponentialBackoffMs } from '../../shared/backoff';

export type SandboxInitStatus = 'pending' | 'provisioning' | 'retrying' | 'ready' | 'failed';
type SandboxHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unknown';

export const SANDBOX_INIT_MAX_ATTEMPTS = 3;
/**
 * Base delay for generic (non-capacity, non-still-building) retries. Previously
 * 2_000ms — when Daytona blipped on attempt 1, the session paid a flat 2s
 * before the retry even started. We now do exponential backoff from 250ms:
 *   attempt 1 fail → 250ms → attempt 2 fail → 500ms → attempt 3 fail → 1000ms
 * Worst-case window is ~1.75s shorter while the retry coverage stays the same.
 */
const RETRY_DELAY_BASE_MS = 250;
const RETRY_DELAY_MAX_MS = 4_000;
const SNAPSHOT_BUILDING_MAX_ATTEMPTS = 30;
const SNAPSHOT_BUILDING_RETRY_DELAY_MS = 10_000;
/**
 * A capacity refusal gets two quick retries before the create gives up and
 * the session's next `/start` takes over with its own backoff (5 s, 10 s, …,
 * session-open-provision.ts). Platinum refuses when every host that could take
 * the box is at its RAM allocation cap; boxes start and stop on that fleet every
 * few seconds, so a slot often frees within one or two. Measured on the dev org
 * 2026-11-02: a refused create landed on its third `/start` attempt ~20 s later.
 * Bounded at ~3 s on purpose: #5993 stopped the 30-attempt loop that held a
 * refused session in "starting" for five minutes.
 */
export const CAPACITY_QUICK_RETRY_DELAYS_MS = [1_000, 2_000] as const;

/**
 * Platinum's "no host can take this box right now" (`no capacity`, or `no
 * capacity on a host that can mount these volumes`): a slot freeing on the
 * fleet clears it. Every other capacity refusal (an org quota or pool, a rate
 * limit, a full disk, another provider's placement error) keeps failing fast
 * on the first attempt, as before.
 */
const FLEET_PLACEMENT_REFUSAL = /"error":"no capacity(?: on a host that can mount these volumes)?"/i;

export function isFleetPlacementRefusal(error: unknown): boolean {
  return FLEET_PLACEMENT_REFUSAL.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The provider refused a create because it is still finishing the image (building or replicating). */
export function isSnapshotStillBuilding(error: unknown): boolean {
  if (error instanceof SnapshotStillBuildingError) return true;
  // legacy: Daytona refuses a create from a snapshot it is still building with
  // only this text. Delete when Daytona types the refusal.
  return (error as Error | null)?.name?.startsWith('Daytona') === true && /snapshot .+ is building/i.test(errorMessage(error));
}

/** The failure keys every builder below drops before it writes its own. */
const SANDBOX_INIT_FAILURE_KEYS = [
  'provisioningError',
  'lastProvisioningError',
  'errorMessage',
  'lastInitError',
] as const;

function stripSandboxInitFailureMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const rest = { ...(metadata ?? {}) };
  for (const key of SANDBOX_INIT_FAILURE_KEYS) delete rest[key];
  return rest;
}

/**
 * A builder's whole object, restated as the strip-and-merge that turns
 * `metadata` into it. The builders read a row snapshot taken before provider
 * create; writing their result back whole erased every key a concurrent writer
 * added since. Applied in SQL to the locked row, the patch keeps those keys.
 */
export function sandboxInitMetadataPatch(
  metadata: Record<string, unknown> | null | undefined,
  built: Record<string, unknown>,
): { strip: string[]; merge: Record<string, unknown> } {
  const previous = metadata ?? {};
  const failureKeys: readonly string[] = SANDBOX_INIT_FAILURE_KEYS;
  const strip = failureKeys.filter((key) => !(key in built));
  const merge: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(built)) {
    // A failure key the builder kept is rewritten even when unchanged: the
    // strip above does not name it, but the builder owns its value.
    if (failureKeys.includes(key) || JSON.stringify(previous[key]) !== JSON.stringify(value)) {
      merge[key] = value;
    }
  }
  return { strip, merge };
}

export function buildSandboxInitAttemptMetadata(
  metadata: Record<string, unknown> | null | undefined,
  attempt: number,
  status: Extract<SandboxInitStatus, 'provisioning' | 'retrying'>,
  provisioningStage?: string | null,
  provisioningMessage?: string | null,
  maxAttempts = SANDBOX_INIT_MAX_ATTEMPTS,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const next = stripSandboxInitFailureMetadata(metadata);
  return {
    ...next,
    initStatus: status,
    initAttempts: attempt,
    initMaxAttempts: maxAttempts,
    lastInitError: null,
    initUpdatedAt: now,
    initStartedAt: typeof next.initStartedAt === 'string' ? next.initStartedAt : now,
    ...(provisioningStage ? { provisioningStage } : {}),
    ...(provisioningMessage ? { provisioningMessage } : {}),
    healthStatus: 'unknown' as SandboxHealthStatus,
  };
}

export function buildSandboxInitSuccessMetadata(
  metadata: Record<string, unknown> | null | undefined,
  resultMetadata: Record<string, unknown>,
  attempt: number,
  maxAttempts = SANDBOX_INIT_MAX_ATTEMPTS,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    ...stripSandboxInitFailureMetadata(metadata),
    ...resultMetadata,
    initStatus: 'ready' as SandboxInitStatus,
    initAttempts: attempt,
    initMaxAttempts: maxAttempts,
    lastInitError: null,
    initSucceededAt: now,
    initUpdatedAt: now,
    healthStatus: 'unknown' as SandboxHealthStatus,
  };
}

export function buildSandboxInitFailureMetadata(
  metadata: Record<string, unknown> | null | undefined,
  error: unknown,
  attempt: number,
  willRetry: boolean,
  maxAttempts = SANDBOX_INIT_MAX_ATTEMPTS,
): Record<string, unknown> {
  const message = errorMessage(error);
  const now = new Date().toISOString();
  const next = stripSandboxInitFailureMetadata(metadata);
  if (willRetry) {
    return {
      ...next,
      initStatus: 'retrying' as SandboxInitStatus,
      initAttempts: attempt,
      initMaxAttempts: maxAttempts,
      lastInitError: message,
      initFailedAt: now,
      initUpdatedAt: now,
      provisioningMessage: `Initialization attempt ${attempt} failed. Retrying…`,
      healthStatus: 'unknown' as SandboxHealthStatus,
    };
  }
  return {
    ...next,
    initStatus: 'failed' as SandboxInitStatus,
    initAttempts: attempt,
    initMaxAttempts: maxAttempts,
    lastInitError: message,
    initFailedAt: now,
    initUpdatedAt: now,
    provisioningStage: 'error',
    provisioningError: message,
    errorMessage: `Initialization failed after ${attempt} attempts. Reinitialize to retry.`,
    healthStatus: 'unknown' as SandboxHealthStatus,
  };
}

export async function retrySandboxProvisionCreate(
  provider: SandboxProvider,
  createOpts: CreateSandboxOpts,
  hooks: {
    onAttemptStart?: (attempt: number, maxAttempts: number) => Promise<void> | void;
    onAttemptFailure?: (
      attempt: number,
      error: unknown,
      willRetry: boolean,
      maxAttempts: number,
    ) => Promise<void> | void;
  } = {},
  // FIX-A: how a single attempt boots. Defaults to the provider's name-based
  // create(); the boot path passes a createFromExternalId-backed fn to boot the
  // exact pinned template id (with the same retry/backoff behavior on transient
  // errors, but fail-fast on a definitive GC'd-pin 404 — see below).
  createFn: (opts: CreateSandboxOpts) => Promise<ProvisionResult> = (opts) => provider.create(opts),
  sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
): Promise<{ result: ProvisionResult; attempts: number }> {
  let lastError: unknown;
  // Outer bound is the longest patience-window we'd extend for any retry class.
  const HARD_CAP = SNAPSHOT_BUILDING_MAX_ATTEMPTS;
  let currentMaxAttempts = SANDBOX_INIT_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= HARD_CAP; attempt++) {
    await hooks.onAttemptStart?.(attempt, currentMaxAttempts);
    try {
      const result = await createFn(createOpts);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      // Memory-snapshot restore gave up (experimental restore kept dropping the
      // runtime). Not retryable here — the caller falls back to the normal
      // snapshot path; retrying would just create more flaky restores.
      //
      // FIX-A: a DEFINITIVE GC'd-pin 404 (SandboxTemplateNotFoundError) is
      // likewise non-retryable here — fail fast so the boot path falls back to a
      // name-boot immediately, rather than burning retries on an id that is gone.
      if (error instanceof WarmRuntimeUnavailableError || error instanceof SandboxTemplateNotFoundError) {
        await hooks.onAttemptFailure?.(attempt, error, false, currentMaxAttempts);
        throw error;
      }
      const snapshotStillBuilding = isSnapshotStillBuilding(error);
      const capacityLimited =
        !snapshotStillBuilding && classifySandboxProvisioningFailure(error).isCapacity;
      const quickCapacityRetry = capacityLimited && isFleetPlacementRefusal(error);
      const maxAttempts = snapshotStillBuilding
        ? SNAPSHOT_BUILDING_MAX_ATTEMPTS
        : capacityLimited
          ? quickCapacityRetry
            ? 1 + CAPACITY_QUICK_RETRY_DELAYS_MS.length
            : 1
          : SANDBOX_INIT_MAX_ATTEMPTS;
      currentMaxAttempts = maxAttempts;
      const willRetry = attempt < maxAttempts;
      await hooks.onAttemptFailure?.(attempt, error, willRetry, maxAttempts);
      if (!willRetry) throw error;
      // Snapshot-building keeps its separate long polling window. Capacity
      // gets its short quick-retry window (CAPACITY_QUICK_RETRY_DELAYS_MS);
      // past it the create fails and the session's next `/start` re-attempts
      // it with backoff.
      const delay = snapshotStillBuilding
        ? SNAPSHOT_BUILDING_RETRY_DELAY_MS
        : quickCapacityRetry
          ? CAPACITY_QUICK_RETRY_DELAYS_MS[attempt - 1] ?? CAPACITY_QUICK_RETRY_DELAYS_MS.at(-1)!
          : exponentialBackoffMs({ attempt, baseMs: RETRY_DELAY_BASE_MS, capMs: RETRY_DELAY_MAX_MS });
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Sandbox initialization failed');
}
