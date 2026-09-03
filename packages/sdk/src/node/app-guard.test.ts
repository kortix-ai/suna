import { describe, expect, test } from 'bun:test';

import { createKortixAppGuard } from './app-guard';

/**
 * One resolver, two identity sources, and groups that are always populated.
 *
 * The defect this exists to make unrepresentable: an App reached through the
 * Kortix gate gets `groupIds` signed into every request, but the same App set to
 * `public` gets identity from its own OAuth session — which proves WHO and says
 * nothing about group membership. An App that guards on groups therefore
 * silently stopped guarding the moment its access mode changed.
 */

const SECRET = 'a'.repeat(48);

async function signedHeader(payload: Record<string, unknown>): Promise<string> {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`kortix-app-viewer:v1\0${body}`));
  // base64url, matching the API's `createHmac(...).digest('base64url')`. Hex
  // here silently produced a signature the verifier rejects, which reads as
  // "the gate path is broken" rather than "the harness signs it wrong".
  const sig = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${body}.${sig}`;
}

function gatedRequest(header: string): Request {
  return new Request('https://app.example/', { headers: { 'x-kortix-app-viewer': header } });
}

const NOW = Math.floor(Date.now() / 1000);
const BASE = { v: 1, appId: 'app-1', userId: 'u1', email: 'a@b.test', accountId: 'acc-1', accessMode: 'private', iat: NOW, exp: NOW + 300 };

describe('the gate path', () => {
  test('takes groups straight from the signed header — no network', async () => {
    let fetched = 0;
    const guard = createKortixAppGuard({
      secret: SECRET,
      backendUrl: 'https://api.example/v1',
      fetch: async () => { fetched += 1; return Response.json({ groups: [] }); },
    });
    const viewer = await guard.viewer(gatedRequest(await signedHeader({ ...BASE, groupIds: ['g-finance', 'g-ops'] })));
    expect(viewer?.groupIds).toEqual(['g-finance', 'g-ops']);
    expect(viewer?.source).toBe('app-gate');
    // The header already carries them; a round trip would be pure latency.
    expect(fetched).toBe(0);
  });

  test('a forged header is nobody, not a viewer with no groups', async () => {
    const guard = createKortixAppGuard({ secret: SECRET, backendUrl: 'https://api.example/v1' });
    const forged = `${btoa(JSON.stringify({ ...BASE, groupIds: [] }))}.deadbeef`;
    expect(await guard.viewer(gatedRequest(forged))).toBeNull();
  });
});

describe('the OAuth path', () => {
  const authStub = (token: string | null) =>
    ({
      viewer: async () =>
        token ? { userId: 'u1', email: 'a@b.test', accounts: [{ account_id: 'acc-1' }], scopes: [], token, expiresAt: Date.now() + 60_000 } : null,
      signInUrl: () => '/api/auth/signin',
    }) as never;

  test('FETCHES groups, so a public App guards exactly like a gated one', async () => {
    const calls: string[] = [];
    const guard = createKortixAppGuard({
      secret: SECRET,
      backendUrl: 'https://api.example/v1',
      auth: authStub('at1'),
      fetch: async (input) => {
        calls.push(String(input));
        return Response.json({ groups: [{ group_id: 'g-finance' }, { group_id: 'g-ops' }] });
      },
    });
    const viewer = await guard.viewer(new Request('https://app.example/'));
    expect(viewer?.source).toBe('kortix-sign-in');
    // The whole point: identical shape to the gate path.
    expect(viewer?.groupIds).toEqual(['g-finance', 'g-ops']);
    expect(calls[0]).toContain('/accounts/acc-1/iam/members/u1/groups');
  });

  test('caches per viewer, so a page with ten guards makes one call', async () => {
    let n = 0;
    const guard = createKortixAppGuard({
      secret: SECRET,
      backendUrl: 'https://api.example/v1',
      auth: authStub('at1'),
      fetch: async () => { n += 1; return Response.json({ groups: [{ group_id: 'g1' }] }); },
    });
    const req = new Request('https://app.example/');
    for (let i = 0; i < 5; i += 1) await guard.viewer(req);
    expect(n).toBe(1);
  });

  test('a groups lookup that fails yields NO groups, never an unguarded viewer', async () => {
    const guard = createKortixAppGuard({
      secret: SECRET,
      backendUrl: 'https://api.example/v1',
      auth: authStub('at1'),
      fetch: async () => Response.json({ error: 'boom' }, { status: 500 }),
    });
    const viewer = await guard.viewer(new Request('https://app.example/'));
    // Identity still holds; group-gated resources simply deny. Inventing an
    // empty-but-trusted group list is how a failed lookup becomes an open door.
    expect(viewer?.userId).toBe('u1');
    expect(viewer?.groupIds).toEqual([]);
  });
});

describe('the guards fail closed', () => {
  test('requireViewer sends an anonymous caller to sign-in instead of through', async () => {
    const guard = createKortixAppGuard({ secret: SECRET, backendUrl: 'https://api.example/v1', auth: { viewer: async () => null, signInUrl: () => '/api/auth/signin' } as never });
    const out = await guard.requireViewer(new Request('https://app.example/private'));
    expect(out.viewer).toBeUndefined();
    expect(out.response?.status).toBe(302);
  });

  test('requireGroup refuses a viewer outside the group', async () => {
    const guard = createKortixAppGuard({ secret: SECRET, backendUrl: 'https://api.example/v1' });
    const req = gatedRequest(await signedHeader({ ...BASE, groupIds: ['g-ops'] }));

    const denied = await guard.requireGroup(req, ['g-finance']);
    expect(denied.viewer).toBeUndefined();
    expect(denied.response?.status).toBe(404); // not 403 — do not confirm it exists

    const allowed = await guard.requireGroup(req, ['g-finance', 'g-ops']);
    expect(allowed.viewer?.userId).toBe('u1');
  });

  test('requireGroup with an empty list denies rather than admitting everyone', async () => {
    // `[]` reads as "no restriction" to a careless caller. It must mean the
    // opposite, or a config bug silently opens a resource.
    const guard = createKortixAppGuard({ secret: SECRET, backendUrl: 'https://api.example/v1' });
    const req = gatedRequest(await signedHeader({ ...BASE, groupIds: ['g-ops'] }));
    expect((await guard.requireGroup(req, [])).viewer).toBeUndefined();
  });
});
