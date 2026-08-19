import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { platformConfig } from '@kortix/sdk';

import type { Auth } from './auth.ts';
import { kortixFromAuth, sdkBackendUrl, withKortixScope } from './sdk.ts';

const originalFetch = globalThis.fetch;

function auth(overrides: Partial<Auth> = {}): Auth {
  return {
    api_base: 'https://api.kortix.com',
    token: 'kortix_pat_test',
    user_id: 'u1',
    user_email: 'u@example.com',
    account_id: 'a1',
    logged_in_at: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('sdkBackendUrl', () => {
  test('appends the version prefix to a bare origin', () => {
    expect(sdkBackendUrl('https://api.kortix.com')).toBe('https://api.kortix.com/v1');
  });

  test('does not double the version prefix when the base already carries it', () => {
    expect(sdkBackendUrl('https://api.kortix.com/v1')).toBe('https://api.kortix.com/v1');
  });

  test('strips a trailing slash before appending the version prefix', () => {
    expect(sdkBackendUrl('https://api.kortix.com/')).toBe('https://api.kortix.com/v1');
  });

  test('keeps localhost on http so a local stack stays reachable', () => {
    expect(sdkBackendUrl('http://localhost:14108')).toBe('http://localhost:14108/v1');
  });

  test('returns an absolute url because the SDK rejects a relative backendUrl outside a browser', () => {
    expect(sdkBackendUrl('https://api.kortix.com').startsWith('https://')).toBe(true);
  });
});

describe('kortixFromAuth', () => {
  test('exposes the session handle the CLI needs', () => {
    const kortix = kortixFromAuth(auth());
    expect(typeof kortix.session).toBe('function');
    expect(typeof kortix.project).toBe('function');
    expect(typeof kortix.projects.list).toBe('function');
  });

  test('reuses one client per host and token so a CLI process holds a single client', () => {
    const a = auth();
    expect(kortixFromAuth(a)).toBe(kortixFromAuth({ ...a }));
  });

  test('mints a distinct client for a different host', () => {
    expect(kortixFromAuth(auth())).not.toBe(
      kortixFromAuth(auth({ api_base: 'https://other.kortix.com' })),
    );
  });

  test('mints a distinct client for a different token', () => {
    expect(kortixFromAuth(auth())).not.toBe(kortixFromAuth(auth({ token: 'kortix_pat_other' })));
  });
});

describe('withKortixScope', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('makes the normalized backend url the platform config for the duration of the call', async () => {
    const seen = await withKortixScope(auth(), async () => platformConfig().backendUrl);
    expect(seen).toBe('https://api.kortix.com/v1');
  });

  test('resolves the auth token through the platform getToken seam', async () => {
    const token = await withKortixScope(auth(), async () => platformConfig().getToken());
    expect(token).toBe('kortix_pat_test');
  });

  test('identifies scoped backend requests as CLI traffic', async () => {
    const source = await withKortixScope(auth(), async () => platformConfig().clientSource);
    expect(source).toBe('cli');
  });

  test('isolates concurrent scopes so a multi-host scan never crosses tokens', async () => {
    const [first, second] = await Promise.all([
      withKortixScope(auth({ api_base: 'https://one.kortix.com', token: 'one' }), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `${platformConfig().backendUrl}|${await platformConfig().getToken()}`;
      }),
      withKortixScope(auth({ api_base: 'https://two.kortix.com', token: 'two' }), async () => {
        return `${platformConfig().backendUrl}|${await platformConfig().getToken()}`;
      }),
    ]);
    expect(first).toBe('https://one.kortix.com/v1|one');
    expect(second).toBe('https://two.kortix.com/v1|two');
  });
});
