import { beforeEach, expect, mock, test } from 'bun:test';

const locallyVerified = new Set<string>();
const inconclusive = new Set<string>();
const remotelyVerified = new Set<string>();
const remoteCalls: string[] = [];
const remoteErrors = new Map<string, { message: string; status?: number } | 'throw'>();

mock.module('../shared/jwt-verify', () => ({
  verifySupabaseJwt: async (token: string) =>
    locallyVerified.has(token)
      ? { ok: true, userId: 'user-1', email: 'user@example.com', payload: { sub: 'user-1' } }
      : { ok: false, reason: inconclusive.has(token) ? 'no-keys' : 'bad-signature' },
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: async (token: string) => {
        remoteCalls.push(token);
        const configuredError = remoteErrors.get(token);
        if (configuredError === 'throw') throw new Error('Supabase unavailable');
        if (configuredError) return { data: { user: null }, error: configuredError };
        return remotelyVerified.has(token)
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
  }),
}));

const { selectPreviewWsUpstreamQuery } = await import('./ws-query');

beforeEach(() => {
  locallyVerified.clear();
  inconclusive.clear();
  remotelyVerified.clear();
  remoteErrors.clear();
  remoteCalls.length = 0;
});

test('preserves an app JWT for a cookie-authenticated app socket', async () => {
  const query = await selectPreviewWsUpstreamQuery(
    '?token=app.jwt.signature&room=1',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query.queryString).toBe('?token=app.jwt.signature&room=1');
  expect(remoteCalls).toEqual([]);
});

test('strips every verified platform JWT while preserving duplicate app tokens in place', async () => {
  locallyVerified.add('platform.jwt.signature');

  const query = await selectPreviewWsUpstreamQuery(
    '?token=app.jwt.signature&room=1&token=platform.jwt.signature&token=opaque-app-token&tail=2',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query.queryString).toBe('?token=app.jwt.signature&room=1&token=opaque-app-token&tail=2');
});

test('uses Supabase fallback only when local platform JWT verification is inconclusive', async () => {
  inconclusive.add('legacy.jwt.signature');
  remotelyVerified.add('legacy.jwt.signature');

  const query = await selectPreviewWsUpstreamQuery(
    '?token=bad.jwt.signature&token=legacy.jwt.signature&room=1',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query.queryString).toBe('?token=bad.jwt.signature&room=1');
  expect(remoteCalls).toEqual(['legacy.jwt.signature']);
});

test('strips an inconclusive JWT when Supabase verification throws', async () => {
  inconclusive.add('unknown.jwt.signature');
  remoteErrors.set('unknown.jwt.signature', 'throw');

  const query = await selectPreviewWsUpstreamQuery(
    '?token=unknown.jwt.signature&room=1',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query.queryString).toBe('?room=1');
});

test('strips inconclusive JWTs when Supabase returns 429 or 5xx', async () => {
  inconclusive.add('limited.jwt.signature');
  inconclusive.add('outage.jwt.signature');
  remoteErrors.set('limited.jwt.signature', { message: 'rate limited', status: 429 });
  remoteErrors.set('outage.jwt.signature', { message: 'service unavailable', status: 503 });

  const query = await selectPreviewWsUpstreamQuery(
    '?token=limited.jwt.signature&token=outage.jwt.signature&room=1',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query.queryString).toBe('?room=1');
});

test('preserves an inconclusive third-party JWT after a definitive Supabase auth rejection', async () => {
  inconclusive.add('third-party.jwt.signature');
  remoteErrors.set('third-party.jwt.signature', { message: 'invalid JWT', status: 401 });

  const query = await selectPreviewWsUpstreamQuery(
    '?token=third-party.jwt.signature&room=1',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query.queryString).toBe('?token=third-party.jwt.signature&room=1');
});

test('strips recognized Kortix keys without verification', async () => {
  const query = await selectPreviewWsUpstreamQuery(
    '?token=kortix_pat_secret&token=app-token',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query.queryString).toBe('?token=app-token');
  expect(remoteCalls).toEqual([]);
});

test('strips all tokens without a preview cookie and on control sockets', async () => {
  const noCookie = await selectPreviewWsUpstreamQuery(
    '?token=app-token&room=1&token=another-app-token',
    { cookieAuthenticated: false, carriesSessionData: false },
  );
  const controlSocket = await selectPreviewWsUpstreamQuery(
    '?token=app-token&room=1',
    { cookieAuthenticated: true, carriesSessionData: true },
  );

  expect(noCookie.queryString).toBe('?room=1');
  expect(controlSocket.queryString).toBe('?room=1');
});

test('removes public share and wake parameters and returns the wake decision', async () => {
  const query = await selectPreviewWsUpstreamQuery(
    '?room=1&public_share=secret&wake=1&token=app-token',
    { cookieAuthenticated: true, carriesSessionData: false },
  );

  expect(query).toEqual({ queryString: '?room=1&token=app-token', wakeRequested: true });
});
