import { describe, expect, test } from 'bun:test';
import { restartClaimIsActive } from './runtime-restart-fence';

describe('runtime restart fence', () => {
  test('recognizes only an unexpired complete claim', () => {
    const now = new Date('2026-08-22T20:00:00.000Z');
    expect(
      restartClaimIsActive(
        {
          runtimeRestartId: 'restart-1',
          runtimeRestartLeaseExpiresAt: '2026-08-22T20:00:01.000Z',
        },
        now,
      ),
    ).toBe(true);
    expect(
      restartClaimIsActive(
        {
          runtimeRestartId: 'restart-1',
          runtimeRestartLeaseExpiresAt: '2026-08-22T19:59:59.000Z',
        },
        now,
      ),
    ).toBe(false);
    expect(restartClaimIsActive({ runtimeRestartId: 'restart-1' }, now)).toBe(
      false,
    );
  });
});
