import { describe, expect, test } from 'bun:test';
import {
  runtimeRestartClaimMetadata,
  restartClaimIsActive,
} from './runtime-restart-fence';

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

  test('builds a durable claim without dropping existing metadata', () => {
    const metadata = runtimeRestartClaimMetadata(
      { providerRunningConfirmedAt: '2026-08-22T19:00:00.000Z' },
      {
        id: 'restart-1',
        startedAt: new Date('2026-08-22T20:00:00.000Z'),
        leaseExpiresAt: new Date('2026-08-22T20:04:00.000Z'),
      },
    );
    expect(metadata).toEqual({
      providerRunningConfirmedAt: '2026-08-22T19:00:00.000Z',
      runtimeRestartId: 'restart-1',
      runtimeRestartStartedAt: '2026-08-22T20:00:00.000Z',
      runtimeRestartLeaseExpiresAt: '2026-08-22T20:04:00.000Z',
      runtimeRestartPhase: 'stopping',
    });
  });
});
