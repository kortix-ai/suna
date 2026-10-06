import { beforeEach, describe, expect, mock, test } from 'bun:test';

const inserted: unknown[] = [];
const seatAdded: string[] = [];
let blocked: { limit: number; members: number } | null = null;

const realDb = await import('../../shared/db');
const realIdentity = await import('./user-identity');
const realAssignments = await import('../../iam/assignments');
mock.module('./user-identity', () => ({ ...realIdentity, getAccountMembership: async () => null }));
mock.module('../../shared/db', () => ({
  ...realDb,
  withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
  db: { execute: async () => {}, insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: async () => void inserted.push(v) }) }) },
}));
mock.module('../../iam/assignments', () => ({ ...realAssignments, assignRole: async () => {} }));
const realSeats = await import('../../billing/services/seat-management');
mock.module('../../billing/services/seat-management', () => ({
  ...realSeats,
  trialSeatLimitBlocksNewMember: async () => blocked,
  onMemberAdded: async (_a: string, userId: string) => void seatAdded.push(userId),
}));

const { ensureOrgMembership } = await import('./project-access');

beforeEach(() => {
  inserted.length = 0;
  seatAdded.length = 0;
  blocked = null;
});

describe('ensureOrgMembership seat accounting', () => {
  test('a new member passes the seat gate and is seat-synced', async () => {
    await expect(ensureOrgMembership('acc', 'user')).resolves.toBe('member');
    expect(inserted).toHaveLength(1);
    expect(seatAdded).toEqual(['user']);
  });

  test('a full trial refuses with 403 and writes no membership', async () => {
    blocked = { limit: 3, members: 3 };
    const err = await ensureOrgMembership('acc', 'user').catch((e) => e);
    expect(err.status).toBe(403);
    expect((await err.getResponse().json()).code).toBe('trial_seat_limit_reached');
    expect(inserted).toHaveLength(0);
    expect(seatAdded).toHaveLength(0);
  });
});
