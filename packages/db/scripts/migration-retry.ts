export interface MigrationRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  maxLockAttempts?: number;
  lockDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
  onLockRetry?: (attempt: number, error: unknown) => void;
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === 'string') return value.code;
  return sqlState(value.cause);
}

function migrationLockBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === 'Another migration is already running') return true;
  return migrationLockBusy(error.cause);
}

/**
 * Retry after PostgreSQL aborts a transaction as a deadlock victim or when
 * node-pg-migrate cannot acquire its advisory lock. The lock error occurs
 * before any migration runs. Other migration failures remain fail-closed.
 */
export async function withMigrationRetry<T>(
  operation: () => Promise<T>,
  options: MigrationRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 1_000;
  const maxLockAttempts = options.maxLockAttempts ?? 13;
  const lockDelayMs = options.lockDelayMs ?? 5_000;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  let deadlockAttempts = 0;
  let lockAttempts = 0;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (migrationLockBusy(error)) {
        lockAttempts += 1;
        if (lockAttempts >= maxLockAttempts) throw error;
        options.onLockRetry?.(lockAttempts, error);
        await sleep(lockDelayMs);
        continue;
      }
      if (sqlState(error) !== '40P01') throw error;
      deadlockAttempts += 1;
      if (deadlockAttempts >= maxAttempts) throw error;
      options.onRetry?.(deadlockAttempts, error);
      await sleep(delayMs * deadlockAttempts);
    }
  }
}
