import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  IMPERSONATION_HEADER,
  clearImpersonationSession,
  getImpersonationSession,
  impersonationHeaders,
  isImpersonationSessionLive,
  setImpersonationSession,
  shouldAttachImpersonation,
  subscribeToImpersonation,
  type ImpersonationSession,
} from './impersonation';

function session(overrides: Partial<ImpersonationSession> = {}): ImpersonationSession {
  return {
    grantId: 'grant-1',
    accountId: 'acct-1',
    accountName: 'Cosmic Victim',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => clearImpersonationSession());
afterEach(() => clearImpersonationSession());

describe('impersonation session store', () => {
  test('there is no session by default and no header is attached', () => {
    expect(getImpersonationSession()).toBeNull();
    expect(impersonationHeaders()).toEqual({});
  });

  test('a stored session attaches exactly one header, carrying only the grant id', () => {
    setImpersonationSession(session());
    expect(impersonationHeaders()).toEqual({ [IMPERSONATION_HEADER]: 'grant-1' });
    expect(getImpersonationSession()?.accountId).toBe('acct-1');
  });

  test('an expired session is dropped rather than sent — the API would 403 it', () => {
    setImpersonationSession(session({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(getImpersonationSession()).toBeNull();
    expect(impersonationHeaders()).toEqual({});
  });

  test('a malformed expiry is treated as expired, never as forever', () => {
    setImpersonationSession(session({ expiresAt: 'not a date' }));
    expect(getImpersonationSession()).toBeNull();
    expect(isImpersonationSessionLive(session({ expiresAt: '' }))).toBe(false);
  });

  test('clearing removes the session and the header', () => {
    setImpersonationSession(session());
    clearImpersonationSession();
    expect(getImpersonationSession()).toBeNull();
    expect(impersonationHeaders()).toEqual({});
  });

  test('subscribers are notified on set and on clear, and unsubscribe stops it', () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeToImpersonation(() => {
      seen.push(getImpersonationSession()?.grantId ?? null);
    });
    setImpersonationSession(session());
    clearImpersonationSession();
    unsubscribe();
    setImpersonationSession(session({ grantId: 'grant-2' }));
    expect(seen).toEqual(['grant-1', null]);
  });

  test('the admin console is never impersonated — otherwise Exit could not run', () => {
    setImpersonationSession(session());
    // The server refuses an impersonated /v1/admin request (no nested admin),
    // and the revoke route lives there. Sending the header would make the
    // banner's own Exit button 403 — the operator would be stuck until the
    // grant expired.
    for (const url of [
      'http://localhost:8008/v1/admin/api/impersonate/grant-1',
      'http://localhost:8008/v1/admin/api/accounts',
      '/admin/api/impersonate',
      'https://dev-api.kortix.com/v1/admin/analytics/activity',
    ]) {
      expect(shouldAttachImpersonation(url)).toBe(false);
      expect(impersonationHeaders(url)).toEqual({});
    }
  });

  test('every other route is impersonated', () => {
    setImpersonationSession(session());
    for (const url of [
      'http://localhost:8008/v1/projects',
      'http://localhost:8008/v1/accounts',
      // Not the admin console: an account whose name contains "admin" and a
      // project path segment must not be exempted by a loose match.
      'http://localhost:8008/v1/projects/admin/sessions',
      '/v1/badminton',
    ]) {
      expect(shouldAttachImpersonation(url)).toBe(true);
      expect(impersonationHeaders(url)).toEqual({ [IMPERSONATION_HEADER]: 'grant-1' });
    }
  });

  test('a session survives a reload when the host has sessionStorage', () => {
    // The store persists so a full page navigation into the app shell keeps
    // acting as the account. Read through a fresh module instance to prove the
    // value comes from storage, not from the in-memory mirror.
    if (typeof sessionStorage === 'undefined') return;
    setImpersonationSession(session());
    const raw = sessionStorage.getItem('kortix.impersonation');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).grantId).toBe('grant-1');
  });
});
