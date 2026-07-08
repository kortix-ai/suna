import { describe, expect, test } from 'bun:test';
import {
  checkSessionScope,
  isLockedSubjectGrant,
  lockedSubjectGrant,
  requestedSessionId,
} from './session-scope';

describe('lockedSubjectGrant', () => {
  test('denies every capability', () => {
    const g = lockedSubjectGrant('support');
    expect(g).toEqual({ agent: 'support', kortixCli: [], connectors: [], env: [] });
  });

  test('isLockedSubjectGrant recognizes the locked shape', () => {
    expect(isLockedSubjectGrant(lockedSubjectGrant('x'))).toBe(true);
  });

  test('isLockedSubjectGrant rejects null and permissive grants', () => {
    expect(isLockedSubjectGrant(null)).toBe(false);
    expect(isLockedSubjectGrant(undefined)).toBe(false);
    expect(isLockedSubjectGrant({ agent: 'a', kortixCli: 'all', connectors: 'all' })).toBe(false);
    // one axis open is not locked
    expect(isLockedSubjectGrant({ agent: 'a', kortixCli: [], connectors: [], env: 'all' })).toBe(
      false,
    );
    expect(
      isLockedSubjectGrant({ agent: 'a', kortixCli: ['project.cr.open'], connectors: [], env: [] }),
    ).toBe(false);
  });
});

describe('requestedSessionId', () => {
  test('extracts from the sessions route', () => {
    expect(requestedSessionId('/v1/projects/proj-1/sessions/sess-abc/prompt')).toBe('sess-abc');
    expect(requestedSessionId('/v1/projects/proj-1/sessions/sess-abc')).toBe('sess-abc');
  });

  test('extracts from the preview/runtime proxy route', () => {
    expect(requestedSessionId('/v1/p/sandbox-xyz/3000/index.html')).toBe('sandbox-xyz');
    expect(requestedSessionId('/v1/p/sandbox-xyz')).toBe('sandbox-xyz');
  });

  test('returns null for non-session-addressed paths', () => {
    expect(requestedSessionId('/v1/projects/proj-1/secrets')).toBeNull();
    expect(requestedSessionId('/v1/projects/proj-1')).toBeNull();
    expect(requestedSessionId('/v1/accounts/me')).toBeNull();
    expect(requestedSessionId('/v1/projects')).toBeNull();
  });

  test('decodes url-encoded segments', () => {
    expect(requestedSessionId('/v1/projects/p/sessions/sess%2Dabc/x')).toBe('sess-abc');
  });
});

describe('checkSessionScope', () => {
  test('non-backend tokens are never gated (behavior unchanged)', () => {
    // A normal session token on some other session, or an account route — all fine.
    expect(
      checkSessionScope({
        backendScoped: false,
        tokenSessionId: 'sess-a',
        path: '/v1/projects/p/sessions/sess-b/prompt',
      }).ok,
    ).toBe(true);
    expect(
      checkSessionScope({ backendScoped: false, tokenSessionId: null, path: '/v1/accounts/me' }).ok,
    ).toBe(true);
  });

  test('backend token may touch exactly its own session', () => {
    expect(
      checkSessionScope({
        backendScoped: true,
        tokenSessionId: 'sess-a',
        path: '/v1/projects/p/sessions/sess-a/prompt',
      }).ok,
    ).toBe(true);
    expect(
      checkSessionScope({
        backendScoped: true,
        tokenSessionId: 'sess-a',
        path: '/v1/p/sess-a/3000/',
      }).ok,
    ).toBe(true);
  });

  test('backend token is refused on a different session', () => {
    const v = checkSessionScope({
      backendScoped: true,
      tokenSessionId: 'sess-a',
      path: '/v1/projects/p/sessions/sess-b/prompt',
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('different session');
  });

  test('backend token fails closed on non-session routes (secrets, account, lists)', () => {
    for (const path of [
      '/v1/projects/p/secrets',
      '/v1/accounts/me',
      '/v1/projects',
      '/v1/projects/p',
    ]) {
      const v = checkSessionScope({ backendScoped: true, tokenSessionId: 'sess-a', path });
      expect(v.ok).toBe(false);
    }
  });

  test('malformed backend token (no bound session) is refused', () => {
    const v = checkSessionScope({
      backendScoped: true,
      tokenSessionId: null,
      path: '/v1/projects/p/sessions/sess-a/prompt',
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('not bound to a session');
  });
});
