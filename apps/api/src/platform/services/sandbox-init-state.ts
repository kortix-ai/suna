import type { CreateSandboxOpts, ProvisionResult, SandboxProvider } from '../providers';

export type SandboxInitStatus = 'pending' | 'provisioning' | 'retrying' | 'ready' | 'failed';
export type SandboxHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unknown';

export const SANDBOX_INIT_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getSandboxMetadata(metadata: unknown): Record<string, unknown> {
  return isRecord(metadata) ? metadata : {};
}

export function getSandboxInitAttempts(metadata: Record<string, unknown> | null | undefined): number {
  const raw = metadata?.initAttempts;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 0;
}

export function getSandboxLastInitError(metadata: Record<string, unknown> | null | undefined): string | null {
  const candidates = [
    metadata?.lastInitError,
    metadata?.provisioningError,
    metadata?.lastProvisioningError,
    metadata?.errorMessage,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

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

export function stripSandboxInitFailureMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
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
  const message = error instanceof Error ? error.message : String(error);
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
  for (let attempt = 1; attempt <= SANDBOX_INIT_MAX_ATTEMPTS; attempt++) {
    await hooks.onAttemptStart?.(attempt);
    try {
      const result = await provider.create(createOpts);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      const willRetry = attempt < SANDBOX_INIT_MAX_ATTEMPTS;
      await hooks.onAttemptFailure?.(attempt, error, willRetry);
      if (!willRetry) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Sandbox initialization failed');
}
