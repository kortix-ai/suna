import { describe, expect, test } from 'bun:test';
import {
  appAccessCookieName,
  appAccessDecision,
  createAppAccessToken,
  verifyAppAccessToken,
} from './access';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const SECRET = 'test-app-access-secret-at-least-32-characters';

describe('Kortix App access', () => {
  test('defaults to owner-only Kortix access and supports every explicit mode', () => {
    const owner = { userId: OWNER_ID, groupIds: [] };
    const member = { userId: MEMBER_ID, groupIds: ['44444444-4444-4444-8444-444444444444'] };

    expect(appAccessDecision({ mode: 'private', ownerId: OWNER_ID, grants: [], subject: owner })).toBe(true);
    expect(appAccessDecision({ mode: 'private', ownerId: OWNER_ID, grants: [], subject: member })).toBe(false);
    expect(appAccessDecision({ mode: 'project', ownerId: OWNER_ID, grants: [], subject: member })).toBe(true);
    expect(appAccessDecision({
      mode: 'restricted', ownerId: OWNER_ID,
      grants: [{ principalType: 'member', principalId: MEMBER_ID }], subject: member,
    })).toBe(true);
    expect(appAccessDecision({
      mode: 'restricted', ownerId: OWNER_ID,
      grants: [{ principalType: 'group', principalId: member.groupIds[0]! }], subject: member,
    })).toBe(true);
    expect(appAccessDecision({ mode: 'restricted', ownerId: OWNER_ID, grants: [], subject: member })).toBe(false);
    expect(appAccessDecision({ mode: 'public', ownerId: OWNER_ID, grants: [], subject: null })).toBe(true);
    expect(appAccessDecision({ mode: 'password', ownerId: OWNER_ID, grants: [], subject: null })).toBe(false);
  });

  test('signs scoped expiring tokens and rejects tampering, expiry, and cross-App reuse', () => {
    const token = createAppAccessToken({
      appId: APP_ID,
      kind: 'kortix',
      userId: OWNER_ID,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    }, SECRET);
    expect(verifyAppAccessToken(token, APP_ID, SECRET, new Date('2029-01-01T00:00:00.000Z'))).toMatchObject({
      appId: APP_ID, kind: 'kortix', userId: OWNER_ID,
    });
    expect(verifyAppAccessToken(`${token}x`, APP_ID, SECRET, new Date('2029-01-01T00:00:00.000Z'))).toBeNull();
    expect(verifyAppAccessToken(token, '55555555-5555-4555-8555-555555555555', SECRET, new Date('2029-01-01T00:00:00.000Z'))).toBeNull();
    expect(verifyAppAccessToken(token, APP_ID, SECRET, new Date('2031-01-01T00:00:00.000Z'))).toBeNull();
  });

  test('uses a host-only secure browser cookie', () => {
    expect(appAccessCookieName()).toBe('__Host-kortix_app_access');
  });
});
