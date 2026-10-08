import { test, expect, beforeEach, describe } from 'bun:test';
import {
  clearKortixAppViewerCache,
  fetchKortixAppViewer,
  kortixAppViewerToken,
} from './app-viewer';

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

describe('an App reaching the Kortix API through its own origin', () => {
  // The API refuses an App origin's CORS preflight. The gate forwards
  // `/_kortix/api/v1/*` to the API as the viewer, and it knows the viewer only
  // by the App's own session cookie, so a relative backendUrl must send it.
  test('a relative backendUrl calls /_kortix/api/v1 with this origin’s credentials', async () => {
    const { createKortix } = await import('../client/kortix');
    const seen: Array<{ url: string; credentials: RequestCredentials | undefined; auth: string | null }> = [];
    const api = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), credentials: init?.credentials, auth: new Headers(init?.headers).get('authorization') });
      return Response.json([]);
    }) as typeof fetch;
    const kortix = createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken({ fetch: fetchImpl }), fetch: api });

    await kortix.projects.list();

    expect(seen).toEqual([{ url: '/_kortix/api/v1/projects', credentials: 'same-origin', auth: 'Bearer kortix_oat_1' }]);
  });

  test('an absolute backendUrl still sends no cookies', async () => {
    const { createKortix } = await import('../client/kortix');
    const seen: Array<RequestCredentials | undefined> = [];
    const api = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.credentials);
      return Response.json([]);
    }) as typeof fetch;
    const kortix = createKortix({ backendUrl: 'https://api.example.test/v1', getToken: kortixAppViewerToken({ fetch: fetchImpl }), fetch: api });

    await kortix.projects.list();

    expect(seen).toEqual(['omit']);
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
