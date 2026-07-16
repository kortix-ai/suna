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
