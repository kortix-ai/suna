import { describe, expect, test } from 'bun:test';
import {
  appAccessCookie,
  appAccessCookieName,
  appAccessDecision,
  appTeamScope,
  appVisibleToSubject,
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

  test('scopes the App to the team the same way a session is scoped', () => {
    const GROUP_ID = '44444444-4444-4444-8444-444444444444';
    const owner = { userId: OWNER_ID, groupIds: [] as string[] };
    const member = { userId: MEMBER_ID, groupIds: [GROUP_ID] };
    const visible = (
      mode: Parameters<typeof appTeamScope>[0],
      subject: { userId: string; groupIds: string[] },
      grants: Array<{ principalType: 'member' | 'group'; principalId: string }> = [],
      isProjectManager = false,
    ) => appVisibleToSubject({ mode, ownerId: OWNER_ID, grants, subject, isProjectManager });

    // private → the member who created it, nobody else.
    expect(visible('private', owner)).toBe(true);
    expect(visible('private', member)).toBe(false);

    // restricted → owner plus the member/group allow-list.
    expect(visible('restricted', member)).toBe(false);
    expect(visible('restricted', member, [{ principalType: 'member', principalId: MEMBER_ID }])).toBe(true);
    expect(visible('restricted', member, [{ principalType: 'group', principalId: GROUP_ID }])).toBe(true);

    // project → the whole project.
    expect(visible('project', member)).toBe(true);

    // A password or a public hostname protects PUBLIC traffic. Neither hides
    // the App from the teammates who operate it.
    expect(visible('password', member)).toBe(true);
    expect(visible('public', member)).toBe(true);

    // A project manager keeps control of every App, so a private App never
    // becomes unmanageable when its creator leaves the account.
    expect(visible('private', member, [], true)).toBe(true);

    expect(appTeamScope('private')).toBe('owner');
    expect(appTeamScope('restricted')).toBe('shared');
    expect(appTeamScope('password')).toBe('team');
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
    expect(appAccessCookie('token')).toContain('; Secure;');
  });

  test('uses a partitioned cookie for an Apps iframe on the trustworthy apps.localhost origin', () => {
    expect(appAccessCookieName(true)).toBe('kortix_app_access');
    const cookie = appAccessCookie('token', 60, true);
    expect(cookie).toStartWith('kortix_app_access=token;');
    expect(cookie).toContain('; HttpOnly;');
    expect(cookie).toContain('; Secure;');
    expect(cookie).toContain('; SameSite=None; Partitioned');
  });
});
