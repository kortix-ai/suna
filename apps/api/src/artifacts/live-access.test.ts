/**
 * The credential half of the live socket's check (Strix: revoked or expired
 * sessions): an expired credential and a signed-out browser session are
 * refused with 401 before any view check runs; a failed session read throws,
 * so the caller keeps the socket and retries.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __setSessionLivenessLoaderForTests } from '../shared/jwt-liveness';
import { checkArtifactLiveAccess } from './live-access';

const USER = '70000000-0000-4000-8000-000000000001';
const ACCOUNT = '70000000-0000-4000-8000-000000000002';
const SESSION = '70000000-0000-4000-8000-000000000003';
const scope = { sessionId: null, projectId: '70000000-0000-4000-8000-000000000004', artifactId: '70000000-0000-4000-8000-000000000005' };
const actor = { userId: USER, accountId: ACCOUNT, credential: { kind: 'jwt' as const }, ctx: {} };

afterEach(() => __setSessionLivenessLoaderForTests(null));

describe('the credential behind a live socket', () => {
  test('an expired credential → 401 credential_expired, with no session read', async () => {
    let reads = 0;
    __setSessionLivenessLoaderForTests(async () => { reads++; return { id: USER, email: '' }; });
    const verdict = await checkArtifactLiveAccess({ ...scope, actor, credential: { authSessionId: SESSION, expiresAt: Date.now() - 1 } });
    expect(verdict).toMatchObject({ ok: false, status: 401, code: 'credential_expired' });
    expect(reads).toBe(0);
  });

  test('a signed-out browser session → 401 credential_revoked', async () => {
    const asked: string[] = [];
    __setSessionLivenessLoaderForTests(async (userId, sessionId) => { asked.push(`${userId}|${sessionId}`); return null; });
    const verdict = await checkArtifactLiveAccess({ ...scope, actor, credential: { authSessionId: SESSION, expiresAt: Date.now() + 60_000 } });
    expect(verdict).toMatchObject({ ok: false, status: 401, code: 'credential_revoked' });
    expect(asked).toEqual([`${USER}|${SESSION}`]);
  });

  test('a failed session read throws: the socket stays and the next re-check retries', async () => {
    __setSessionLivenessLoaderForTests(async () => { throw new Error('auth.sessions unavailable'); });
    await expect(checkArtifactLiveAccess({ ...scope, actor, credential: { authSessionId: SESSION, expiresAt: Date.now() + 60_000 } }))
      .rejects.toThrow('auth.sessions unavailable');
  });
});
