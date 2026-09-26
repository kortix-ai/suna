import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthUser } from '../e2e/helpers/session-auth';

// A 504 from the auth admin endpoint does not mean the user was not created:
// the proxy gave up while GoTrue was still working. The helper resends the
// create, so the resend can meet the user its first request made. That must
// resolve to the same user, not fail the journey before it starts.

const options = { supabaseUrl: 'https://auth.test', password: 'pw-1' };
const created = { id: 'user-1', email: 'journey@example.test' };

type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let calls: string[] = [];

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  calls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1_000 });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`);
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
});

const session = (user: typeof created) => ({
  access_token: 'at', refresh_token: 'rt', expires_at: 0, expires_in: 0, token_type: 'bearer', user,
});

describe('createAuthUser after a 504', () => {
  it('an email_exists on the resend resolves to the user the first request created', async () => {
    replies = [
      { status: 504, body: { error_code: 'request_timeout' } },
      { status: 422, body: { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' } },
      { status: 200, body: session(created) },
    ];
    await expect(createAuthUser(created.email, options)).resolves.toEqual(created);
    expect(calls).toEqual([
      'POST /auth/v1/admin/users',
      'POST /auth/v1/admin/users',
      'POST /auth/v1/token?grant_type=password',
    ]);
  });

  it('a unique-key conflict on the resend resolves the same way', async () => {
    replies = [
      { status: 504, body: {} },
      { status: 500, body: { code: '23505', message: 'duplicate key value violates unique constraint "users_email_partial_key"' } },
      { status: 200, body: session(created) },
    ];
    await expect(createAuthUser(created.email, options)).resolves.toEqual(created);
  });

  it('an email_exists with no earlier 504 is still an error: the email was taken before this call', async () => {
    replies = [{ status: 422, body: { error_code: 'email_exists' } }];
    await expect(createAuthUser(created.email, options)).rejects.toThrow('got 422');
    expect(calls).toHaveLength(1);
  });
});
