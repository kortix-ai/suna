import { test, expect, beforeEach, describe } from 'bun:test';
import {
  clearKortixAppViewerCache,
  fetchKortixAppViewer,
  kortixAppViewerToken,
  kortixBinding,
  kortixToken,
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

describe('kortixToken', () => {
  let tokens = 0;
  let status = 200;
  const tokenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    expect(init?.credentials).toBe('same-origin');
    if (status !== 200) return Response.json({ error: 'nope' }, { status });
    tokens += 1;
    return Response.json({ token: `jwt-${tokens}`, expires_at: new Date(Date.now() + 900_000).toISOString(), audience: 'app-id' });
  }) as typeof fetch;

  beforeEach(() => {
    tokens = 0;
    status = 200;
  });

  test('with no audience, a token for this App itself from its own origin, cached', async () => {
    const fetchToken = kortixToken({ fetch: tokenFetch });
    expect(await fetchToken()).toBe('jwt-1');
    expect(await fetchToken()).toBe('jwt-1');
    expect(calls).toEqual(['/_kortix/token']);
  });

  test('an audience names an App this App uses, by slug or id', async () => {
    expect(await kortixToken({ audience: 'my db', fetch: tokenFetch })()).toBe('jwt-1');
    expect(calls).toEqual(['/_kortix/token?audience=my%20db']);
  });

  test('forceRefreshToken skips the cache (the shape realtime clients call it with)', async () => {
    const fetchToken = kortixToken({ audience: 'db', fetch: tokenFetch });
    await fetchToken();
    expect(await fetchToken({ forceRefreshToken: true })).toBe('jwt-2');
  });

  test('one cache per audience; concurrent callers share one request', async () => {
    const [a, b] = await Promise.all([
      kortixToken({ audience: 'db', fetch: tokenFetch })(),
      kortixToken({ audience: 'db', fetch: tokenFetch })(),
    ]);
    expect(a).toBe(b);
    expect(await kortixToken({ audience: 'billing', fetch: tokenFetch })()).toBe('jwt-2');
    expect(calls).toEqual(['/_kortix/token?audience=db', '/_kortix/token?audience=billing']);
  });

  test('nobody signed in, an agent viewer, viewer identity off: null, never a throw, never cached', async () => {
    for (const code of [401, 403, 404, 409]) {
      status = code;
      expect(await kortixToken({ audience: 'db', fetch: tokenFetch })()).toBeNull();
    }
    status = 200;
    expect(await kortixToken({ audience: 'db', fetch: tokenFetch })()).toBe('jwt-1');
  });

  test('an App this App does not use: null, and one console warning that names the fix', async () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const notLinked = (async () =>
        Response.json(
          { error: 'app_not_linked', error_description: 'This App does not use an App named "crm".' },
          { status: 403 },
        )) as unknown as typeof fetch;
      expect(await kortixToken({ audience: 'crm', fetch: notLinked })()).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]![0])).toContain('This App does not use an App named "crm".');
      // Another refusal (no viewer) stays silent.
      status = 401;
      expect(await kortixToken({ audience: 'db', fetch: tokenFetch })()).toBeNull();
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
    const fetchToken = kortixToken({ audience: 'db', fetch: shortFetch });
    await fetchToken();
    expect(await fetchToken()).toBe('jwt-2');
  });

  test('clearKortixAppViewerCache drops these tokens too (sign-out)', async () => {
    const fetchToken = kortixToken({ audience: 'db', fetch: tokenFetch });
    await fetchToken();
    clearKortixAppViewerCache();
    expect(await fetchToken()).toBe('jwt-2');
  });
});

describe('kortixBinding', () => {
  test('the bindings mount on this App origin, and a token for the bound App', async () => {
    let asked = '';
    const binding = kortixBinding('db', {
      origin: 'https://crm.apps.example.test',
      fetch: (async (input: RequestInfo | URL) => {
        asked = String(input);
        return Response.json({ token: 'jwt-db', expires_at: new Date(Date.now() + 900_000).toISOString() });
      }) as typeof fetch,
    });
    expect(binding.url).toBe('https://crm.apps.example.test/_kortix/apps/db');
    expect(await binding.token()).toBe('jwt-db');
    expect(asked).toBe('/_kortix/token?audience=db');
  });

  test('trims trailing slashes off the origin in linear time (CodeQL js/polynomial-redos)', () => {
    expect(kortixBinding('db', { origin: 'https://crm.apps.example.test///' }).url).toBe(
      'https://crm.apps.example.test/_kortix/apps/db',
    );
    // `/\/+$/` backtracks quadratically on a slash run that does not end the
    // string: ~3.5 s at 100k slashes under bun 1.3, well under 1 ms linear.
    const origin = `https://crm.apps.example.test${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(kortixBinding('db', { origin }).url).toBe(`${origin}/_kortix/apps/db`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('reads the origin from the page, and refuses without one', () => {
    const location = (globalThis as { location?: unknown }).location;
    try {
      (globalThis as { location?: unknown }).location = { origin: 'https://site.apps.example.test' };
      expect(kortixBinding('my-db').url).toBe('https://site.apps.example.test/_kortix/apps/my-db');
      (globalThis as { location?: unknown }).location = undefined;
      expect(() => kortixBinding('db')).toThrow('origin');
    } finally {
      (globalThis as { location?: unknown }).location = location;
    }
  });
});
