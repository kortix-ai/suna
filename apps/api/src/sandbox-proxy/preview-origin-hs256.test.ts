/**
 * A preview ORIGIN request carrying an HS256-signed Supabase JWT, end to end
 * through the real `handlePreviewOriginRequest` + the real `preview-auth`.
 *
 * The incident this locks down: a Supabase project whose JWKS publishes an
 * ES256 key while the auth server still SIGNS with the legacy HS256 secret.
 * `verifySupabaseJwt` then loads a key, meets an algorithm it cannot check, and
 * answers `unsupported-alg:HS256` — inconclusive, not a verdict. `combinedAuth`
 * routes that to the network `getUser`, so `/v1/*` and the path proxy
 * `/v1/p/<sandbox>/<port>/` both served the token; `preview-auth` hard-rejected
 * it, so EVERY browser preview origin answered 401 "Sign in to open this
 * preview" for a signed-in owner whose token was fine.
 *
 * `preview-origin.test.ts` mocks `./preview-auth` wholesale and therefore
 * cannot see this. Here only the verifier, the auth server, ownership and the
 * upstream are stubbed; the credential travels the real path.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realPreviewOwnership from '../shared/preview-ownership';

const configState: Record<string, unknown> = {
  FRONTEND_URL: 'https://dev.kortix.com',
  KORTIX_URL: 'https://dev-api.kortix.com',
  INTERNAL_KORTIX_ENV: 'dev',
  PORT: 8008,
  API_KEY_SECRET: 'test-secret-value-32-chars-long!!',
  KORTIX_PREVIEW_BASE_DOMAIN: undefined,
};
mock.module('../config', () => ({ config: configState }));

/** The token under test — signature checked by the auth server, never locally. */
const HS256_JWT = 'header.hs256.payload';
/** A token the local verifier CAN judge, and rejects. Must never reach getUser. */
const BAD_JWT = 'header.bad.payload';

let getUserCalls: string[] = [];
let supabaseUser: { id: string } | null = null;
let allowedUsers = new Set<string>();
let forwarded = 0;

mock.module('./backend', () => ({
  resolveExternalIdFromHostLabel: async (label: string) =>
    label === 'sbx-known' ? 'sbx_KNOWN' : null,
}));

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async (t: string) =>
    t === HS256_JWT
      ? { ok: false, reason: 'unsupported-alg:HS256' }
      : { ok: false, reason: 'bad-signature' },
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: async (t: string) => {
        getUserCalls.push(t);
        return {
          data: { user: supabaseUser },
          error: supabaseUser ? null : { message: 'invalid' },
        };
      },
    },
  }),
}));

// Spread the real module: `mock.module` replaces it wholesale, so a hand-listed
// stub deletes every export it omits.
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async ({ userId }: { userId?: string }) =>
    !!userId && allowedUsers.has(userId),
}));

mock.module('./routes/preview', () => ({
  forwardToSandbox: async () => {
    forwarded += 1;
    return new Response('upstream', { status: 200 });
  },
}));

mock.module('../shared/session-public-shares', () => ({
  PUBLIC_SHARE_BLOCKED_PORTS: new Set<number>([22, 4096, 8000, 3211]),
  STATIC_FILE_SHARE_PORT: 3211,
  PUBLIC_SHARE_VIEW_METHODS: new Set(['GET', 'HEAD', 'OPTIONS']),
  isViewOnlyShare: () => true,
  publicShareToken: (shareId: string) => `kps_${shareId.replaceAll('-', '')}`,
  resolvePublicShare: async () => ({ ok: false }),
  touchPublicShare: async () => {},
}));

const { handlePreviewOriginRequest } = await import('./preview-origin');
const { PREVIEW_STATE_HEADER } = await import('./preview-state-page');

const HOST = 'p8081-sbx-known.localhost:8008';

function navigate(path: string): [Request, URL] {
  const req = new Request(`http://127.0.0.1:8008${path}`, {
    headers: { host: HOST, 'sec-fetch-dest': 'document' },
  });
  return [req, new URL(`http://${HOST.split(':')[0]}:8008${path}`)];
}

beforeEach(() => {
  getUserCalls = [];
  supabaseUser = { id: 'user-owner' };
  allowedUsers = new Set(['user-owner']);
  forwarded = 0;
});

describe('preview origin — HS256-signed Supabase JWT', () => {
  test('the owner is signed in and bounced to the clean address, not to the gate', async () => {
    const res = await handlePreviewOriginRequest(...navigate(`/?token=${HS256_JWT}`));

    expect(res?.status).toBe(302);
    expect(res?.headers.get('location')).toBe('/');
    // Two cookie copies (see preview-session.ts) — the session really exists.
    expect(res!.headers.getSetCookie().length).toBe(2);
    // The auth server is the ONLY thing that can judge a symmetric signature,
    // so the token must actually have reached it.
    expect(getUserCalls).toEqual([HS256_JWT]);
  });

  test('the minted cookie then serves the app with no token in the URL', async () => {
    const first = await handlePreviewOriginRequest(...navigate(`/?token=${HS256_JWT}`));
    const cookie = first!.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    const req = new Request('http://127.0.0.1:8008/', {
      headers: { host: HOST, 'sec-fetch-dest': 'document', Cookie: cookie },
    });
    const res = await handlePreviewOriginRequest(req, new URL('http://p8081-sbx-known.localhost:8008/'));

    expect(res?.status).toBe(200);
    expect(forwarded).toBe(1);
  });

  test('an HS256 token whose user does not own the sandbox still gets the gate', async () => {
    allowedUsers = new Set(['someone-else']);
    const res = await handlePreviewOriginRequest(...navigate(`/?token=${HS256_JWT}`));

    expect(res?.status).toBe(401);
    expect(res?.headers.get(PREVIEW_STATE_HEADER)).toBe('signed-out');
    expect(forwarded).toBe(0);
  });

  test('a locally-judged bad signature is refused without asking the auth server', async () => {
    const res = await handlePreviewOriginRequest(...navigate(`/?token=${BAD_JWT}`));

    expect(res?.status).toBe(401);
    expect(getUserCalls).toEqual([]);
  });
});
