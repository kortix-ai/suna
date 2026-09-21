import { describe, expect, test } from 'bun:test';

import type { Host } from '@kortix/cli/src/api/config.ts';
import type { ValidateTokenResult } from '@kortix/sdk';

import {
  type LoginFlowDeps,
  hostBaseFromBackendUrl,
  loginToHost,
  normalizeBackendUrl,
  pickAccount,
  redactSecret,
  removeLoginHost,
} from './login-flow.ts';

const TOKEN = 'kortix_pat_super_secret_value_0123456789';

/** An in-memory stand-in for `~/.config/kortix/config.json`. */
function fakeStore(initial: Record<string, Host> = {}) {
  const hosts: Record<string, Host> = { ...initial };
  let active = '';
  const saved: Array<{ name: string; host: Host; makeActive: boolean }> = [];
  const deps: Partial<LoginFlowDeps> = {
    save: (name, host, makeActive) => {
      hosts[name] = host;
      if (makeActive) active = name;
      saved.push({ name, host, makeActive });
    },
    read: (name) => hosts[name] ?? null,
    remove: (name) => {
      if (!hosts[name]) return { removed: false };
      delete hosts[name];
      return { removed: true };
    },
    now: () => new Date('2026-09-17T12:00:00.000Z'),
  };
  return { hosts, saved, deps, activeName: () => active };
}

function validIdentity(): ValidateTokenResult {
  return {
    valid: true,
    identity: {
      user_id: 'user-1',
      email: 'agent-g@kortix.test',
      accounts: [
        { account_id: 'acc-1', slug: 'acc1', name: 'First', role: 'owner' },
        { account_id: 'acc-2', slug: 'acc2', name: 'Second', role: 'member' },
      ],
    },
  };
}

describe('normalizeBackendUrl', () => {
  test('adds the /v1 mount exactly once', () => {
    expect(normalizeBackendUrl('http://localhost:17408')).toBe('http://localhost:17408/v1');
    expect(normalizeBackendUrl('http://localhost:17408/v1')).toBe('http://localhost:17408/v1');
    expect(normalizeBackendUrl('http://localhost:17408/')).toBe('http://localhost:17408/v1');
  });

  test('a schemeless private host stays on http', () => {
    expect(normalizeBackendUrl('localhost:17408')).toBe('http://localhost:17408/v1');
    expect(normalizeBackendUrl('127.0.0.1:8008')).toBe('http://127.0.0.1:8008/v1');
  });

  test('a schemeless public host is upgraded to https', () => {
    expect(normalizeBackendUrl('api.kortix.com')).toBe('https://api.kortix.com/v1');
    expect(normalizeBackendUrl('http://api.kortix.com')).toBe('https://api.kortix.com/v1');
  });

  test('rejects what is not an http(s) URL', () => {
    expect(normalizeBackendUrl('')).toBeNull();
    expect(normalizeBackendUrl('   ')).toBeNull();
    expect(normalizeBackendUrl('ftp://example.com')).toBeNull();
    expect(normalizeBackendUrl('http://')).toBeNull();
  });

  test('hostBaseFromBackendUrl drops the mount the CLI does not store', () => {
    expect(hostBaseFromBackendUrl('http://localhost:17408/v1')).toBe('http://localhost:17408');
  });
});

describe('redactSecret', () => {
  test('replaces every occurrence of the token', () => {
    expect(redactSecret(`sent ${TOKEN} twice ${TOKEN}`, TOKEN)).toBe('sent «token» twice «token»');
  });

  test('leaves text alone when there is no token to hide', () => {
    expect(redactSecret('nothing here', '')).toBe('nothing here');
  });
});

describe('pickAccount', () => {
  test('takes the preferred account when the token can see it', () => {
    const accounts = validIdentity().identity?.accounts ?? [];
    expect(pickAccount(accounts, 'acc-2')?.account_id).toBe('acc-2');
  });

  test('falls back to the first account', () => {
    const accounts = validIdentity().identity?.accounts ?? [];
    expect(pickAccount(accounts, 'acc-missing')?.account_id).toBe('acc-1');
    expect(pickAccount(accounts)?.account_id).toBe('acc-1');
    expect(pickAccount([])).toBeNull();
  });
});

describe('loginToHost — success', () => {
  test('saves the host record with the identity and makes it active', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'local-dev', url: 'localhost:17408', token: TOKEN },
      { ...store.deps, validate: async () => validIdentity() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a successful login');
    expect(result.resolved).toEqual({
      name: 'local-dev',
      backendUrl: 'http://localhost:17408/v1',
      token: TOKEN,
      accountId: 'acc-1',
      defaultProjectId: undefined,
      userEmail: 'agent-g@kortix.test',
      source: 'config',
    });

    const saved = store.hosts['local-dev'] as Host;
    expect(saved.url).toBe('http://localhost:17408');
    expect(saved.user_id).toBe('user-1');
    expect(saved.user_email).toBe('agent-g@kortix.test');
    expect(saved.account_id).toBe('acc-1');
    expect(saved.account_slug).toBe('acc1');
    expect(saved.account_name).toBe('First');
    expect(saved.token).toBe(TOKEN);
    expect(saved.logged_in_at).toBe('2026-09-17T12:00:00.000Z');
    expect(store.activeName()).toBe('local-dev');
  });

  test('honors the preferred account', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN, preferredAccountId: 'acc-2' },
      { ...store.deps, validate: async () => validIdentity() },
    );
    expect(result.ok).toBe(true);
    expect((store.hosts.cloud as Host).account_id).toBe('acc-2');
    expect((store.hosts.cloud as Host).url).toBe('https://api.kortix.com');
  });

  test('keeps a default project only while it belongs to the account logged into', async () => {
    const store = fakeStore({
      cloud: {
        url: 'https://api.kortix.com',
        token: 'old',
        user_id: 'u',
        user_email: 'old@kortix.test',
        account_id: 'acc-1',
        default_project: { project_id: 'p1', account_id: 'acc-1' },
        logged_in_at: '2026-01-01T00:00:00.000Z',
      },
    });

    await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN },
      { ...store.deps, validate: async () => validIdentity() },
    );
    expect((store.hosts.cloud as Host).default_project?.project_id).toBe('p1');

    await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN, preferredAccountId: 'acc-2' },
      { ...store.deps, validate: async () => validIdentity() },
    );
    expect((store.hosts.cloud as Host).default_project).toBeUndefined();
  });

  test('makeActive: false stores the host without switching to it', async () => {
    const store = fakeStore();
    await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN, makeActive: false },
      { ...store.deps, validate: async () => validIdentity() },
    );
    expect(store.hosts.cloud).toBeDefined();
    expect(store.activeName()).toBe('');
  });
});

describe('loginToHost — failures', () => {
  test('401 reports the status and never saves', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN },
      {
        ...store.deps,
        validate: async () => ({
          valid: false,
          error: Object.assign(new Error('Invalid API key'), { status: 401, name: 'ApiError' }),
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejected login');
    expect(result.error.kind).toBe('rejected');
    expect(result.error.status).toBe(401);
    expect(result.error.message).toBe('Token rejected (401): Invalid API key');
    expect(store.saved).toHaveLength(0);
  });

  test('a network failure reports the origin and status 0', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'local-dev', url: 'localhost:1', token: TOKEN },
      {
        ...store.deps,
        validate: async () => ({
          valid: false,
          error: Object.assign(
            new Error('Unable to connect. Is the computer able to access the url?'),
            {
              name: 'ApiError',
            },
          ),
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a network failure');
    expect(result.error.kind).toBe('network');
    expect(result.error.status).toBe(0);
    expect(result.error.message).toBe(
      'Cannot reach http://localhost:1/v1: Unable to connect. Is the computer able to access the url?',
    );
    expect(store.saved).toHaveLength(0);
  });

  test('a non-auth HTTP status is reported verbatim', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN },
      {
        ...store.deps,
        validate: async () => ({
          valid: false,
          error: Object.assign(new Error('Bad gateway'), { status: 502, name: 'ApiError' }),
        }),
      },
    );
    if (result.ok) throw new Error('expected an HTTP failure');
    expect(result.error.kind).toBe('http');
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe('HTTP 502: Bad gateway');
  });

  test('a validate() that throws becomes a rendered failure, not a crash', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN },
      {
        ...store.deps,
        validate: async () => {
          throw new Error('socket hang up');
        },
      },
    );
    if (result.ok) throw new Error('expected a thrown transport failure');
    expect(result.error.kind).toBe('network');
    expect(result.error.message).toContain('socket hang up');
  });

  test('an invalid host name is refused before any network call', async () => {
    const store = fakeStore();
    let called = 0;
    const result = await loginToHost(
      { name: '9bad name', url: 'api.kortix.com', token: TOKEN },
      {
        ...store.deps,
        validate: async () => {
          called += 1;
          return validIdentity();
        },
      },
    );
    if (result.ok) throw new Error('expected a name failure');
    expect(result.error.kind).toBe('name');
    expect(called).toBe(0);
  });

  test('an unparseable URL is refused before any network call', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'cloud', url: 'not a url at all', token: TOKEN },
      { ...store.deps, validate: async () => validIdentity() },
    );
    if (result.ok) throw new Error('expected a url failure');
    expect(result.error.kind).toBe('url');
    expect(result.error.message).toContain('not a url at all');
  });

  test('an empty token is refused before any network call', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: '   ' },
      { ...store.deps, validate: async () => validIdentity() },
    );
    if (result.ok) throw new Error('expected a token failure');
    expect(result.error.kind).toBe('token');
  });
});

describe('the token never reaches a message', () => {
  test('an API error that echoes the token is redacted', async () => {
    const store = fakeStore();
    const result = await loginToHost(
      { name: 'cloud', url: 'api.kortix.com', token: TOKEN },
      {
        ...store.deps,
        validate: async () => ({
          valid: false,
          error: Object.assign(
            new Error(`GET https://api.kortix.com/v1/accounts/me?token=${TOKEN} failed`),
            { status: 401, name: 'ApiError' },
          ),
        }),
      },
    );
    if (result.ok) throw new Error('expected a rejected login');
    expect(result.error.message).not.toContain(TOKEN);
    expect(result.error.message).toContain('«token»');
  });

  test('every failure path returns a message free of the token', async () => {
    const store = fakeStore();
    const cases: Array<Partial<LoginFlowDeps>> = [
      {
        validate: async () => ({
          valid: false,
          error: Object.assign(new Error(TOKEN), { status: 401 }),
        }),
      },
      {
        validate: async () => ({
          valid: false,
          error: Object.assign(new Error(TOKEN), { status: 500 }),
        }),
      },
      { validate: async () => ({ valid: false, error: Object.assign(new Error(TOKEN), {}) }) },
      {
        validate: async () => {
          throw new Error(`boom ${TOKEN}`);
        },
      },
    ];
    for (const override of cases) {
      const result = await loginToHost(
        { name: 'cloud', url: 'api.kortix.com', token: TOKEN },
        { ...store.deps, ...override },
      );
      if (result.ok) throw new Error('expected a failure');
      expect(result.error.message).not.toContain(TOKEN);
    }
  });
});

describe('removeLoginHost', () => {
  test('removes through the injected store', () => {
    const store = fakeStore({
      scratch: {
        url: 'http://localhost:1',
        token: TOKEN,
        user_id: '',
        user_email: '',
        account_id: '',
        logged_in_at: '',
      },
    });
    expect(removeLoginHost('scratch', store.deps)).toEqual({ removed: true });
    expect(store.hosts.scratch).toBeUndefined();
    expect(removeLoginHost('scratch', store.deps)).toEqual({ removed: false });
  });
});
