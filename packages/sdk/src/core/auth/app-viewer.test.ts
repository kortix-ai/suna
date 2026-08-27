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
