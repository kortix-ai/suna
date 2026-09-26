import { describe, expect, test } from 'bun:test';
import { withMigrationDeadlockRetry } from './migration-retry';

describe('withMigrationDeadlockRetry', () => {
  test('waits for a migration advisory lock and then runs pending migrations', async () => {
    let calls = 0;
    const waits: number[] = [];
    const retries: number[] = [];

    const result = await withMigrationDeadlockRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('Another migration is already running');
      return 'applied';
    }, {
      maxLockAttempts: 4,
      lockDelayMs: 25,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      onLockRetry: (attempt) => { retries.push(attempt); },
    });

    expect(result).toBe('applied');
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(waits).toEqual([25, 25]);
  });

  test('stops after the migration lock retry limit', async () => {
    const failure = new Error('Another migration is already running');
    let calls = 0;

    await expect(withMigrationDeadlockRetry(async () => {
      calls += 1;
      throw failure;
    }, { maxLockAttempts: 3, sleep: async () => {} })).rejects.toBe(failure);
    expect(calls).toBe(3);
  });

  test('retries a rolled-back PostgreSQL deadlock and returns the next result', async () => {
    let calls = 0;
    const waits: number[] = [];
    const retries: number[] = [];

    const result = await withMigrationDeadlockRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        return 'applied';
      },
      {
        delayMs: 25,
        sleep: async (milliseconds) => { waits.push(milliseconds); },
        onRetry: (attempt) => { retries.push(attempt); },
      },
    );

    expect(result).toBe('applied');
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(waits).toEqual([25, 50]);
  });

  test('does not retry a deterministic migration failure', async () => {
    const failure = Object.assign(new Error('unsupported provider rows'), { code: 'P0001' });
    let calls = 0;

    await expect(withMigrationDeadlockRetry(async () => {
      calls += 1;
      throw failure;
    }, { sleep: async () => {} })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  test('stops after the configured deadlock attempt limit', async () => {
    let calls = 0;
    const failure = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    await expect(withMigrationDeadlockRetry(async () => {
      calls += 1;
      throw failure;
    }, { maxAttempts: 2, sleep: async () => {} })).rejects.toBe(failure);
    expect(calls).toBe(2);
  });
});
