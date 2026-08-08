export interface MigrationRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === 'string') return value.code;
  return sqlState(value.cause);
}

/**
 * Retry a fully transactional migration after PostgreSQL aborts it as a
 * deadlock victim. node-pg-migrate rolls the transaction back before this
 * function receives SQLSTATE 40P01, so each attempt starts from committed
 * state. Other migration failures remain fail-closed.
 */
export async function withMigrationDeadlockRetry<T>(
  operation: () => Promise<T>,
  options: MigrationRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 1_000;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (sqlState(error) !== '40P01' || attempt >= maxAttempts) throw error;
      options.onRetry?.(attempt, error);
      await sleep(delayMs * attempt);
    }
  }
}
