import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';

import { callerKortixSessionId } from './caller-session';

/** Minimal stand-in for the two context vars this reads. */
const ctx = (authType?: string, sessionId?: string) =>
  ({
    get: (key: string) => (key === 'authType' ? authType : key === 'sessionId' ? sessionId : undefined),
  }) as unknown as Context;

describe('callerKortixSessionId', () => {
  test('a browser Supabase JWT is NOT session-bound, whatever sessionId holds', () => {
    // THE BUG. supabaseAuth sets sessionId to the SUPABASE AUTH session so the
    // per-account gate can do idle/force-logout. Treating it as a Kortix session
    // made every isolation guard classify a logged-in human as an agent:
    // approvals 403'd, the needs-input badge read 0, and a KaaB operator could
    // not see their own backend sessions in the dashboard.
    expect(callerKortixSessionId(ctx('supabase', 'e2b1d6a0-supabase-auth-session'))).toBeNull();
  });

  test('a sandbox PAT keeps its real Kortix session id — the guards depend on it', () => {
    // If this returned null, the cross-end-user isolation guard would stop
    // firing and one end-user's sandbox could reach another's session again.
    expect(callerKortixSessionId(ctx('pat', 'sess-123'))).toBe('sess-123');
  });

  test('a PAT with no session id is not session-bound', () => {
    expect(callerKortixSessionId(ctx('pat', undefined))).toBeNull();
  });

  test('an api key / service account passes its session id through when present', () => {
    expect(callerKortixSessionId(ctx('apiKey', 'sess-abc'))).toBe('sess-abc');
    expect(callerKortixSessionId(ctx('service_account', undefined))).toBeNull();
  });

  test('an unknown future token kind is NOT silently unbound', () => {
    // Excluding only 'supabase' (rather than allow-listing 'pat') means a new
    // session-minting token kind keeps narrowing by default. Failing open here
    // would quietly re-open cross-end-user access.
    expect(callerKortixSessionId(ctx('some_future_kind', 'sess-xyz'))).toBe('sess-xyz');
  });

  test('no authType at all still yields null when there is no session id', () => {
    expect(callerKortixSessionId(ctx(undefined, undefined))).toBeNull();
  });
});
