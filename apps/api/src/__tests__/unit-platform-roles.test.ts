import { beforeEach, describe, expect, mock, test } from 'bun:test';

let mockedRows: Array<{ role: 'user' | 'admin' | 'super_admin' }> = [];

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => mockedRows,
        }),
      }),
    }),
  },
}));

const { getPlatformRole, isPlatformAdmin } = await import('../shared/platform-roles');

describe('platform roles', () => {
  beforeEach(() => {
    mockedRows = [];
  });

  test('defaults to user when no role row exists', async () => {
    expect(await getPlatformRole('acc_test_123')).toBe('user');
    expect(await isPlatformAdmin('acc_test_123')).toBe(false);
  });

  test('returns admin when admin row exists', async () => {
    mockedRows = [{ role: 'admin' }];

    expect(await getPlatformRole('acc_test_123')).toBe('admin');
    expect(await isPlatformAdmin('acc_test_123')).toBe(true);
  });

  test('returns super_admin when super admin row exists', async () => {
    mockedRows = [{ role: 'super_admin' }];

    expect(await getPlatformRole('acc_test_123')).toBe('super_admin');
    expect(await isPlatformAdmin('acc_test_123')).toBe(true);
  });
});
