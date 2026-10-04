import { describe, expect, test } from 'bun:test';
import { runProviderActions } from './provider-actions';

describe('provider action fan-out', () => {
  test('keeps healthy providers moving when a sibling fails', async () => {
    const result = await runProviderActions(
      ['daytona', 'platinum', 'e2b'] as const,
      async (provider) => {
        if (provider === 'platinum') throw new Error('provider unavailable');
        return `${provider}-started`;
      },
    );

    expect(result.started).toEqual([
      { provider: 'daytona', result: 'daytona-started' },
      { provider: 'e2b', result: 'e2b-started' },
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.provider).toBe('platinum');
    expect(result.failed[0]?.error).toBeInstanceOf(Error);
    expect((result.failed[0]?.error as Error).message).toBe('provider unavailable');
  });
});

describe('rebuild failure response', () => {
  test('every provider refusing an in-use image answers 409 SNAPSHOT_IN_USE, not 503', async () => {
    const { rebuildFailureResponse } = await import('./provider-actions');
    const { SnapshotInUseError } = await import('./providers/errors');
    const response = rebuildFailureResponse([
      { provider: 'platinum', error: new SnapshotInUseError('kortix-default-abc', 4) },
    ]);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'SNAPSHOT_IN_USE',
      in_use: 4,
      failed_providers: ['platinum'],
    });
    expect(response.body.error).toMatch(/4 running sandboxes/);
  });

  test('any other provider failure stays 503 and names the failed providers', async () => {
    const { rebuildFailureResponse } = await import('./provider-actions');
    const { SnapshotInUseError } = await import('./providers/errors');
    const response = rebuildFailureResponse([
      { provider: 'platinum', error: new SnapshotInUseError('kortix-default-abc', 1) },
      { provider: 'daytona', error: new Error('daytona -> 500') },
    ]);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: 'Could not start a rebuild on any sandbox provider',
      failed_providers: ['platinum', 'daytona'],
    });
  });
});
