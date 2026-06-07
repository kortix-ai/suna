import type { CreateSandboxOpts, ProvisionResult, SandboxProvider } from '../providers';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSnapshotStillBuilding(error: unknown): boolean {
  return /snapshot .+ is building/i.test(errorMessage(error));
}

/**
 * Provider is temporarily at capacity (no compute runners free in our region,
 * org-wide rate limit, etc.). These clear on their own in ~30s–2min, so the
 * right move is to keep the session in `provisioning` and quietly poll instead
 * of bouncing it to `error` after 3 fast retries.
 *
 * Recognized signals (case-insensitive substring match on the error message):
 *   - "no available runners"      — Daytona infra at capacity
 *   - "capacity"                  — generic provider capacity errors
 *   - "rate limit" / "ratelimit"  — quota / throttling
 *   - "too many requests"         — HTTP 429 style
 */
function isProviderCapacityLimited(error: unknown): boolean {
  const m = errorMessage(error).toLowerCase();
  return (
    m.includes('no available runner') ||
    m.includes('no runners available') ||
    m.includes('out of capacity') ||
    m.includes('capacity exceeded') ||
    m.includes('rate limit') ||
    m.includes('ratelimit') ||
    m.includes('too many requests')
  );
}

/** Number of attempts + base delay for capacity-limited retries (~5 min window). */
const PROVIDER_CAPACITY_MAX_ATTEMPTS = 30;
const PROVIDER_CAPACITY_RETRY_DELAY_MS = 10_000;

export function deriveSandboxInitStatus(
  lifecycleStatus: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): SandboxInitStatus {
  const raw = metadata?.initStatus;
  if (raw === 'pending' || raw === 'provisioning' || raw === 'retrying' || raw === 'ready' || raw === 'failed') {
    return raw;
  }
  switch (lifecycleStatus) {
    case 'active':
    case 'stopped':
    case 'archived':
      return 'ready';
    case 'provisioning':
      return 'provisioning';
    case 'error':
      return 'failed';
    default:
      return 'pending';
  }
}

export function deriveSandboxHealthStatus(
  lifecycleStatus: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): SandboxHealthStatus {
  const raw = metadata?.healthStatus;
  if (raw === 'healthy' || raw === 'degraded' || raw === 'offline' || raw === 'unknown') {
    return raw;
  }
  if (lifecycleStatus === 'stopped' || lifecycleStatus === 'archived') return 'offline';
  return 'unknown';
}

function stripSandboxInitFailureMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const source = metadata ?? {};
  const {
    provisioningError: _provisioningError,
    lastProvisioningError: _lastProvisioningError,
    errorMessage: _errorMessage,
    lastInitError: _lastInitError,
    ...rest
  } = source;
  return rest;
}

export function buildSandboxInitAttemptMetadata(
  metadata: Record<string, unknown> | null | undefined,
  attempt: number,
  status: Extract<SandboxInitStatus, 'provisioning' | 'retrying'>,
  provisioningStage?: string | null,
  provisioningMessage?: string | null,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const next = stripSandboxInitFailureMetadata(metadata);
  return {
    ...next,
    initStatus: status,
    initAttempts: attempt,
    initMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
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
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    ...stripSandboxInitFailureMetadata(metadata),
    ...resultMetadata,
    initStatus: 'ready' as SandboxInitStatus,
    initAttempts: attempt,
    initMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
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
): Record<string, unknown> {
  const message = errorMessage(error);
  const now = new Date().toISOString();
  const next = stripSandboxInitFailureMetadata(metadata);
  if (willRetry) {
    return {
      ...next,
      initStatus: 'retrying' as SandboxInitStatus,
      initAttempts: attempt,
      initMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
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
    initMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
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
    onAttemptStart?: (attempt: number) => Promise<void> | void;
    onAttemptFailure?: (attempt: number, error: unknown, willRetry: boolean) => Promise<void> | void;
  } = {},
): Promise<{ result: ProvisionResult; attempts: number }> {
  let lastError: unknown;
  // Outer bound is the longest patience-window we'd extend for any retry class.
  const HARD_CAP = Math.max(SNAPSHOT_BUILDING_MAX_ATTEMPTS, PROVIDER_CAPACITY_MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= HARD_CAP; attempt++) {
    await hooks.onAttemptStart?.(attempt);
    try {
      const result = await provider.create(createOpts);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      const snapshotStillBuilding = isSnapshotStillBuilding(error);
      const capacityLimited = !snapshotStillBuilding && isProviderCapacityLimited(error);
      const maxAttempts = snapshotStillBuilding
        ? SNAPSHOT_BUILDING_MAX_ATTEMPTS
        : capacityLimited
          ? PROVIDER_CAPACITY_MAX_ATTEMPTS
          : SANDBOX_INIT_MAX_ATTEMPTS;
      const willRetry = attempt < maxAttempts;
      await hooks.onAttemptFailure?.(attempt, error, willRetry);
      if (!willRetry) throw error;
      // Generic retries use exponential backoff from RETRY_DELAY_BASE_MS,
      // capped at RETRY_DELAY_MAX_MS. Snapshot-building and provider-capacity
      // keep their long fixed windows since they're "wait for an external
      // condition," not "retry a flaky call."
      const delay = snapshotStillBuilding
        ? SNAPSHOT_BUILDING_RETRY_DELAY_MS
        : capacityLimited
          ? PROVIDER_CAPACITY_RETRY_DELAY_MS
          : Math.min(RETRY_DELAY_BASE_MS * 2 ** (attempt - 1), RETRY_DELAY_MAX_MS);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Sandbox initialization failed');
}
