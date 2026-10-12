import { describe, expect, test } from 'bun:test';
import { appAccessCookieName, appAccessSecret, createAppAccessToken, verifyAppAccessToken } from './access';
import { renewedAppAccessCookie } from './public-proxy-access';

const app = { appId: '00000000-0000-4000-a000-0000000000a1', accessRevision: 3 };
const url = new URL('https://dev-crm-0123456789abcdef.apps.kortix.com/_kortix/token');
const now = new Date('2026-10-10T12:00:00Z');
const hours = (h: number) => new Date(now.getTime() + h * 3600_000);
const request = (cookie: string) =>
  new Request(url, { headers: { cookie: `${appAccessCookieName(false)}=${cookie}` } });
const cookie = (over: Partial<{ kind: 'kortix' | 'password'; userId: string; revision: number; expiresAt: Date }> = {}) =>
  createAppAccessToken({ appId: app.appId, kind: 'kortix', userId: 'user-1', revision: 3, expiresAt: hours(2), ...over }, appAccessSecret());

describe('renewedAppAccessCookie', () => {
  test('a cookie with under 4 h left is renewed for 8 h, same user and revision', () => {
    const set = renewedAppAccessCookie(request(cookie()), url, app, 'user-1', now);
    expect(set).toContain('Max-Age=28800');
    const value = set!.split(';')[0]!.split('=').slice(1).join('=');
    const payload = verifyAppAccessToken(value, app.appId, appAccessSecret(), now)!;
    expect(payload.userId).toBe('user-1');
    expect(payload.revision).toBe(3);
    expect(payload.exp).toBe(Math.floor(hours(8).getTime() / 1000));
  });

  test('a fresh cookie, another user, an old revision, a password session or no cookie is not renewed', () => {
    expect(renewedAppAccessCookie(request(cookie({ expiresAt: hours(7) })), url, app, 'user-1', now)).toBeNull();
    expect(renewedAppAccessCookie(request(cookie()), url, app, 'user-2', now)).toBeNull();
    expect(renewedAppAccessCookie(request(cookie({ revision: 2 })), url, app, 'user-1', now)).toBeNull();
    expect(renewedAppAccessCookie(request(cookie({ kind: 'password', userId: undefined })), url, app, 'user-1', now)).toBeNull();
    expect(renewedAppAccessCookie(new Request(url), url, app, 'user-1', now)).toBeNull();
  });
});
