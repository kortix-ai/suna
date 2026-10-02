import { describe, expect, test } from 'bun:test';
import { runArchiveTick } from './worker';

const never = () => {
  throw new Error('must not be called');
};

describe('audit archive worker gating', () => {
  test('does nothing while AUDIT_ARCHIVE_ENABLED is off', async () => {
    const result = await runArchiveTick({ enabled: false, configured: true, lockMode: never, run: never });
    expect(result).toEqual({ ran: false, reason: 'disabled' });
  });

  test('does nothing without a bucket', async () => {
    expect(await runArchiveTick({ enabled: true, configured: false, lockMode: never, run: never })).toEqual({ ran: false, reason: 'no bucket configured' });
  });

  test('refuses a bucket without Object Lock: an archive that can be deleted is not evidence', async () => {
    const result = await runArchiveTick({ enabled: true, configured: true, lockMode: async () => null, run: never });
    expect(result).toEqual({ ran: false, reason: 'bucket has no Object Lock configuration' });
  });

  test('runs one pass with the bucket default lock mode and a 3 hour budget', async () => {
    const seen: Array<{ mode: string; budgetMs: number }> = [];
    const result = await runArchiveTick({
      enabled: true,
      configured: true,
      lockMode: async () => 'GOVERNANCE',
      run: async (mode, budgetMs) => {
        seen.push({ mode, budgetMs });
        return { archived: ['2026-07-06'], removed: [], expired: [], legacyRetired: false };
      },
    });
    expect(seen).toEqual([{ mode: 'GOVERNANCE', budgetMs: 3 * 3_600_000 }]);
    expect(result).toMatchObject({ ran: true, archived: ['2026-07-06'] });
  });
});
