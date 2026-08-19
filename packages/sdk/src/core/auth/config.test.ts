import { describe, expect, test } from 'bun:test';

import { fetchKortixAuthConfig } from './config';
import { KortixAuthError } from './errors';

const OK_BODY = {
  provider: 'supabase',
  url: 'https://supa.kortix.test',
  anon_key: 'anon-key-1',
  methods: ['magic', 'password'],
  providers: ['google'],
  signups_enabled: true,
};

interface Capture {
  url: string;
  init?: RequestInit;
}

function recordingFetch(respond: () => Response) {
  const calls: Capture[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('fetchKortixAuthConfig', () => {
  test('requests /v1/auth/config from a bare origin', async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json(OK_BODY));
    await fetchKortixAuthConfig({ backendUrl: 'https://api.kortix.test', fetch: fetchImpl });
    expect(calls[0]?.url).toBe('https://api.kortix.test/v1/auth/config');
  });

  test('requests /v1/auth/config from a base that already carries /v1', async () => {
    // Both forms are documented as valid `backendUrl`s — the apiBase rule from
    // core/rest/platform-client/host-boundary.ts. Doubling /v1 is a 404.
    const { calls, fetchImpl } = recordingFetch(() => Response.json(OK_BODY));
    await fetchKortixAuthConfig({ backendUrl: 'https://api.kortix.test/v1/', fetch: fetchImpl });
    expect(calls[0]?.url).toBe('https://api.kortix.test/v1/auth/config');
  });

  test('never sends an Authorization header', async () => {
    // The route is public and its response is `Cache-Control: public`. Sending a
    // credential to it would be a second auth path and would poison shared caches.
    const { calls, fetchImpl } = recordingFetch(() => Response.json(OK_BODY));
    await fetchKortixAuthConfig({ backendUrl: 'https://api.kortix.test/v1', fetch: fetchImpl });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has('Authorization')).toBe(false);
    expect(headers.get('Accept')).toBe('application/json');
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  test('maps a 200 to a camelCase KortixAuthConfig and strips a trailing slash', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json({ ...OK_BODY, url: 'https://supa.kortix.test/' }),
    );
    const config = await fetchKortixAuthConfig({
      backendUrl: 'https://api.kortix.test/v1',
      fetch: fetchImpl,
    });
    expect(config).toEqual({
      provider: 'supabase',
      url: 'https://supa.kortix.test',
      anonKey: 'anon-key-1',
      methods: ['magic', 'password'],
      providers: ['google'],
      signupsEnabled: true,
    });
  });

  test('forwards an AbortSignal', async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json(OK_BODY));
    const controller = new AbortController();
    await fetchKortixAuthConfig({
      backendUrl: 'https://api.kortix.test/v1',
      fetch: fetchImpl,
      signal: controller.signal,
    });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  test('503 becomes auth_config_unavailable with the status preserved', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json({ error: 'auth_config_unavailable' }, { status: 503 }),
    );
    const error = await fetchKortixAuthConfig({
      backendUrl: 'https://api.kortix.test/v1',
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KortixAuthError);
    expect((error as KortixAuthError).status).toBe(503);
    expect((error as KortixAuthError).code).toBe('auth_config_unavailable');
  });

  test('404 becomes auth_config_unsupported and the message names the route', async () => {
    // An SDK newer than the deployment must say WHICH route is missing, not
    // fail with a generic JSON parse error.
    const { fetchImpl } = recordingFetch(() => new Response('Not Found', { status: 404 }));
    const error = (await fetchKortixAuthConfig({
      backendUrl: 'https://api.kortix.test/v1',
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught)) as KortixAuthError;

    expect(error).toBeInstanceOf(KortixAuthError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('auth_config_unsupported');
    expect(error.message).toContain('GET /v1/auth/config');
  });

  test('an unknown provider is a typed error, never a silent guess', async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ ...OK_BODY, provider: 'okta' }));
    const error = (await fetchKortixAuthConfig({
      backendUrl: 'https://api.kortix.test/v1',
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught)) as KortixAuthError;

    expect(error).toBeInstanceOf(KortixAuthError);
    expect(error.code).toBe('auth_config_unsupported_provider');
    expect(error.message).toContain('okta');
  });

  test('a 200 missing url or anon_key is a typed error', async () => {
    for (const body of [
      { ...OK_BODY, url: '' },
      { ...OK_BODY, anon_key: '' },
    ]) {
      const { fetchImpl } = recordingFetch(() => Response.json(body));
      const error = (await fetchKortixAuthConfig({
        backendUrl: 'https://api.kortix.test/v1',
        fetch: fetchImpl,
      }).catch((caught: unknown) => caught)) as KortixAuthError;
      expect(error).toBeInstanceOf(KortixAuthError);
      expect(error.code).toBe('auth_config_invalid');
    }
  });

  test('defaults methods and providers when the deployment omits them', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json({ provider: 'supabase', url: 'https://supa.kortix.test', anon_key: 'k' }),
    );
    const config = await fetchKortixAuthConfig({
      backendUrl: 'https://api.kortix.test/v1',
      fetch: fetchImpl,
    });
    expect(config.methods).toEqual(['magic', 'password']);
    expect(config.providers).toEqual([]);
    expect(config.signupsEnabled).toBe(true);
  });

  test('a non-JSON 500 body is tolerated and reported with its status', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('<html>502</html>', { status: 500 }));
    const error = (await fetchKortixAuthConfig({
      backendUrl: 'https://api.kortix.test/v1',
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught)) as KortixAuthError;
    expect(error.status).toBe(500);
    expect(error.body).toBe('<html>502</html>');
  });
});
