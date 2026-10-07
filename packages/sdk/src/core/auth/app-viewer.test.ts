import { test, expect, beforeEach, describe } from 'bun:test';
import {
  clearKortixAppViewerCache,
  fetchKortixAppViewer,
  kortixAppBackendToken,
  kortixAppViewerToken,
} from './app-viewer';
import { readKortixMember } from './kortix-member';

let calls: string[] = [];
let respond: () => Response = () => Response.json(session());

const session = (over: Record<string, unknown> = {}) => ({
  app_id: 'app-1',
  access_mode: 'restricted',
  account_id: 'acct-1',
  user_id: 'user-1',
  email: 'viewer@example.test',
  group_ids: ['group-1'],
  scopes: ['profile', 'email', 'kortix'],
  access_token: 'kortix_oat_1',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});

const fetchImpl = (async (input: RequestInfo | URL) => {
  calls.push(String(input));
  return respond();
}) as typeof fetch;

beforeEach(() => {
  calls = [];
  respond = () => Response.json(session());
  clearKortixAppViewerCache();
});

describe('fetchKortixAppViewer', () => {
  test('reads the gate on this App’s own origin and caches the answer', async () => {
    const first = await fetchKortixAppViewer({ fetch: fetchImpl });
    expect(first).toMatchObject({ user_id: 'user-1', access_token: 'kortix_oat_1' });
    await fetchKortixAppViewer({ fetch: fetchImpl });
    expect(calls).toEqual(['/_kortix/viewer']);
  });

  test('concurrent callers share one request', async () => {
    const [a, b, c] = await Promise.all([
      fetchKortixAppViewer({ fetch: fetchImpl }),
      fetchKortixAppViewer({ fetch: fetchImpl }),
      fetchKortixAppViewer({ fetch: fetchImpl }),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test('a signed-out visitor, an opted-out App and a network failure are all "no viewer", never a throw', async () => {
    respond = () => Response.json({ error: 'no_viewer_identity' }, { status: 401 });
    expect(await fetchKortixAppViewer({ fetch: fetchImpl })).toBeNull();
    clearKortixAppViewerCache();
    respond = () => Response.json({ error: 'viewer_disabled' }, { status: 404 });
    expect(await fetchKortixAppViewer({ fetch: fetchImpl })).toBeNull();
    clearKortixAppViewerCache();
    respond = () => {
      throw new Error('offline');
    };
    expect(await fetchKortixAppViewer({ fetch: fetchImpl })).toBeNull();
  });

  test('refetches once the token is inside the refresh skew', async () => {
    respond = () => Response.json(session({ expires_at: new Date(Date.now() + 30_000).toISOString() }));
    await fetchKortixAppViewer({ fetch: fetchImpl });
    await fetchKortixAppViewer({ fetch: fetchImpl });
    expect(calls).toHaveLength(2);
  });
});

describe('kortixAppViewerToken', () => {
  test('is a getToken: the viewer’s bearer, or null when there is none', async () => {
    const getToken = kortixAppViewerToken({ fetch: fetchImpl });
    expect(await getToken()).toBe('kortix_oat_1');
    clearKortixAppViewerCache();
    respond = () => Response.json(session({ access_token: null, expires_at: null }));
    expect(await kortixAppViewerToken({ fetch: fetchImpl })()).toBeNull();
  });
});

describe('a viewer token the API rejects', () => {
  // The gate revokes every viewer token when the App's access policy is saved.
  // A browser App holding the cached token must recover on the next request,
  // not answer 401 until the token's hour runs out.
  test('the one 401 replay re-reads /_kortix/viewer and succeeds with the new token', async () => {
    const { createKortix } = await import('../client/kortix');
    const { authenticatedFetch } = await import('../http/auth');
    let issued = 0;
    respond = () => Response.json(session({ access_token: `kortix_oat_${++issued}` }));
    const sent: string[] = [];
    const api = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get('authorization') ?? '';
      sent.push(bearer);
      return bearer === 'Bearer kortix_oat_1'
        ? Response.json({ error: 'Invalid OAuth access token' }, { status: 401 })
        : Response.json({ ok: true });
    }) as typeof fetch;
    createKortix({ backendUrl: 'https://api.example.test/v1', getToken: kortixAppViewerToken({ fetch: fetchImpl }), fetch: api });

    const response = await authenticatedFetch('https://api.example.test/v1/projects');

    expect(response.status).toBe(200);
    expect(sent).toEqual(['Bearer kortix_oat_1', 'Bearer kortix_oat_2']);
    expect(calls).toEqual(['/_kortix/viewer', '/_kortix/viewer']);
    // The replacement is cached like any other: the next call asks the gate nothing.
    await authenticatedFetch('https://api.example.test/v1/projects');
    expect(calls).toHaveLength(2);
    expect(sent.at(-1)).toBe('Bearer kortix_oat_2');
  });

  test('a rejection of an older token never drops a newer cached one', async () => {
    const getToken = kortixAppViewerToken({ fetch: fetchImpl });
    expect(await getToken()).toBe('kortix_oat_1');
    getToken.invalidate?.('kortix_oat_stale');
    expect(await getToken()).toBe('kortix_oat_1');
    expect(calls).toHaveLength(1);
  });
});

describe('the viewer carries the whole member', () => {
  test('name, picture, group names, role and project read through readKortixMember', async () => {
    respond = () =>
      Response.json(
        session({
          name: 'Ada Lovelace',
          picture: 'https://example.test/ada.png',
          groups: ['Finance'],
          role: 'admin',
          project_id: 'proj-1',
        }),
      );
    const viewer = await fetchKortixAppViewer({ fetch: fetchImpl });
    expect(viewer?.name).toBe('Ada Lovelace');
    expect(readKortixMember(viewer)).toMatchObject({
      userId: 'user-1',
      name: 'Ada Lovelace',
      groups: ['Finance'],
      groupIds: ['group-1'],
      role: 'admin',
      accountId: 'acct-1',
      projectId: 'proj-1',
    });
  });
});

describe('kortixAppBackendToken', () => {
  let tokens = 0;
  let status = 200;
  const backendFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    expect(init?.credentials).toBe('same-origin');
    if (status !== 200) return Response.json({ error: 'nope' }, { status });
    tokens += 1;
    return Response.json({ token: `jwt-${tokens}`, expires_at: new Date(Date.now() + 900_000).toISOString() });
  }) as typeof fetch;

  beforeEach(() => {
    tokens = 0;
    status = 200;
  });

  test('fetches a token for the named backend from the App origin and caches it', async () => {
    const fetchToken = kortixAppBackendToken('main', { fetch: backendFetch });
    expect(await fetchToken()).toBe('jwt-1');
    expect(await fetchToken()).toBe('jwt-1');
    expect(calls).toEqual(['/_kortix/backend-token?backend=main']);
  });

  test('forceRefreshToken skips the cache (the shape realtime clients call it with)', async () => {
    const fetchToken = kortixAppBackendToken('main', { fetch: backendFetch });
    await fetchToken();
    expect(await fetchToken({ forceRefreshToken: true })).toBe('jwt-2');
  });

  test('one cache per backend; concurrent callers share one request', async () => {
    const [a, b] = await Promise.all([
      kortixAppBackendToken('main', { fetch: backendFetch })(),
      kortixAppBackendToken('main', { fetch: backendFetch })(),
    ]);
    expect(a).toBe(b);
    expect(await kortixAppBackendToken('billing', { fetch: backendFetch })()).toBe('jwt-2');
    expect(calls).toEqual(['/_kortix/backend-token?backend=main', '/_kortix/backend-token?backend=billing']);
  });

  test('nobody signed in, no such backend, an agent viewer: null, never a throw, never cached', async () => {
    for (const code of [401, 403, 404, 409]) {
      status = code;
      expect(await kortixAppBackendToken('main', { fetch: backendFetch })()).toBeNull();
    }
    status = 200;
    expect(await kortixAppBackendToken('main', { fetch: backendFetch })()).toBe('jwt-1');
  });

  test('a backend the App does not list: null, and one console warning that names the fix', async () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const notListed = (async () =>
        Response.json(
          { error: 'backend_not_listed', error_description: 'This App does not list the backend "crm".' },
          { status: 403 },
        )) as unknown as typeof fetch;
      expect(await kortixAppBackendToken('crm', { fetch: notListed })()).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]![0])).toContain('This App does not list the backend "crm".');
      // Another refusal (no viewer) stays silent.
      status = 401;
      expect(await kortixAppBackendToken('main', { fetch: backendFetch })()).toBeNull();
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  test('refetches once the cached token is inside the refresh skew', async () => {
    const shortFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      tokens += 1;
      return Response.json({ token: `jwt-${tokens}`, expires_at: new Date(Date.now() + 30_000).toISOString() });
    }) as typeof fetch;
    const fetchToken = kortixAppBackendToken('main', { fetch: shortFetch });
    await fetchToken();
    expect(await fetchToken()).toBe('jwt-2');
  });

  test('clearKortixAppViewerCache drops backend tokens too (sign-out)', async () => {
    const fetchToken = kortixAppBackendToken('main', { fetch: backendFetch });
    await fetchToken();
    clearKortixAppViewerCache();
    expect(await fetchToken()).toBe('jwt-2');
  });
});
