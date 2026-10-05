/**
 * `/v1/platform/github-app/*` — the mutation gate and every redirect target.
 *
 * Two contracts live here, both paid for by the 2026-09-16 production
 * incident:
 *
 * 1. An env-managed instance is IMMUTABLE from the UI. Every route that writes
 *    the identity or the git backend answers 409 and names the variables that
 *    own it. On cloud that is the whole surface, so the button that shadowed
 *    production's App from a customer's settings page cannot be pressed.
 * 2. Every callback lands on a route that EXISTS. The old helper redirected to
 *    `<FRONTEND_URL>/accounts/<id>?tab=git`, which apps/web has never served,
 *    so every managed-git callback 404ed.
 *
 * `mock.module` is process-global in bun:test, so this file owns its process
 * (`bun test --isolate`, which is how `pnpm --filter @kortix/api test` runs).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// PEM-shaped, assembled at runtime so no contiguous armor literal reaches the
// secret scanner (gitleaks `private-key`). Not a key; the gate only needs
// "env owns the identity".
const FAKE_ENV_PEM = ['-----BEGIN', ' RSA PRIVATE KEY', '-----env-----'].join('');

process.env.FRONTEND_URL = 'https://dev.kortix.com';

const realAuth = await import('../../middleware/auth');
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-4000-a000-000000000001');
    return next();
  },
}));
const realRequireAdmin = await import('../../middleware/require-admin');
mock.module('../../middleware/require-admin', () => ({
  ...realRequireAdmin,
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { githubAppSetupRouter } = await import('./github-app');
const { buildGitHubAppInstallState } = await import('../../projects/github');

const ENV_KEYS = [
  'KORTIX_GITHUB_APP_ID',
  'GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'KORTIX_GITHUB_APP_SLUG',
  'GITHUB_APP_SLUG',
  'MANAGED_GIT_GITHUB_OWNER',
  'MANAGED_GIT_GITHUB_TOKEN',
  'MANAGED_GIT_GITHUB_INSTALL_ID',
] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_GITHUB_APP_STATE_SECRET = 'state-secret-for-gate-tests';
  process.env.SUPABASE_JWT_SECRET = 'jwt-secret-for-gate-tests';
  // Any network call in these paths is a bug: every case asserted here must be
  // decided before GitHub is reached.
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`unexpected network call: ${String(input instanceof Request ? input.url : input)}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function makeEnvManaged() {
  process.env.KORTIX_GITHUB_APP_ID = '3812697';
  process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = FAKE_ENV_PEM;
  process.env.MANAGED_GIT_GITHUB_OWNER = 'managed-kortix';
  process.env.MANAGED_GIT_GITHUB_TOKEN = 'ghp_env';
}

const MUTATIONS: Array<{ name: string; call: () => Promise<Response> | Response }> = [
  {
    name: 'POST /manifest-start',
    call: () =>
      githubAppSetupRouter.request('/manifest-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
  },
  {
    name: 'POST /app',
    call: () =>
      githubAppSetupRouter.request('/app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: '1', private_key: 'pem', installation_id: '2' }),
      }),
  },
  {
    name: 'POST /pat',
    call: () =>
      githubAppSetupRouter.request('/pat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'ghp_x', owner: 'acme' }),
      }),
  },
  {
    name: 'DELETE /',
    call: () => githubAppSetupRouter.request('/', { method: 'DELETE' }),
  },
];

describe('every mutation route refuses an env-managed instance', () => {
  for (const mutation of MUTATIONS) {
    test(`${mutation.name} answers 409 instance_identity_is_env_managed`, async () => {
      makeEnvManaged();

      const res = await mutation.call();
      expect(res.status).toBe(409);

      const body = (await res.json()) as {
        error: string;
        message: string;
        env_owned_by: string[];
      };
      expect(body.error).toBe('instance_identity_is_env_managed');
      expect(body.env_owned_by).toEqual([
        'KORTIX_GITHUB_APP_ID',
        'KORTIX_GITHUB_APP_PRIVATE_KEY',
        'MANAGED_GIT_GITHUB_OWNER',
        'MANAGED_GIT_GITHUB_TOKEN',
      ]);
      // The message must name the variables, or an operator cannot act on it.
      expect(body.message).toContain('KORTIX_GITHUB_APP_ID');
      expect(body.message).toContain('MANAGED_GIT_GITHUB_TOKEN');
    });
  }

  test('a mutable instance passes the gate and reaches the handler', async () => {
    // No env configuration at all: the gate lets the request through, and the
    // handler then rejects the body on its own terms (400, not 409).
    const res = await githubAppSetupRouter.request('/app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: '', private_key: '', installation_id: '' }),
    });

    expect(res.status).toBe(400);
  });
});

describe('platform-setup redirects land on /admin/git', () => {
  test('manifest-callback with a tampered state', async () => {
    const res = await githubAppSetupRouter.request('/manifest-callback?state=not-a-state');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://dev.kortix.com/admin/git?github=error&reason=invalid_state',
    );
  });

  test('manifest-callback with GitHub reporting an error', async () => {
    const res = await githubAppSetupRouter.request(
      '/manifest-callback?state=not-a-state&error=access_denied',
    );

    expect(res.headers.get('location')).toBe(
      'https://dev.kortix.com/admin/git?github=error&reason=access_denied',
    );
  });

  test('manifest-callback on an env-managed instance is refused, not applied', async () => {
    makeEnvManaged();

    const res = await githubAppSetupRouter.request('/manifest-callback?code=abc&state=whatever');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://dev.kortix.com/admin/git?github=error&reason=instance_identity_is_env_managed',
    );
  });

  test('install-callback for platform setup without an installation id', async () => {
    const state = buildGitHubAppInstallState('account-1', {
      nonce: 'n1',
      purpose: 'platform_setup',
    });

    const res = await githubAppSetupRouter.request(
      `/install-callback?state=${encodeURIComponent(state)}`,
    );

    expect(res.headers.get('location')).toBe(
      'https://dev.kortix.com/admin/git?github=error&reason=missing_installation_id',
    );
  });

  test('install-callback with an unusable state', async () => {
    const res = await githubAppSetupRouter.request('/install-callback?installation_id=42&state=bad');

    expect(res.headers.get('location')).toBe(
      'https://dev.kortix.com/admin/git?github=error&reason=invalid_state',
    );
  });
});

describe('account-link redirects land on /github/setup', () => {
  test('a link error carries the account id and the reason', async () => {
    const state = buildGitHubAppInstallState('account-7', {
      nonce: 'n2',
      purpose: 'account_link',
    });

    const res = await githubAppSetupRouter.request(
      `/install-callback?state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://dev.kortix.com/github/setup?github=error&reason=missing_installation_id&account_id=account-7',
    );
  });

  test('a link error honours the origin the flow started from', async () => {
    const state = buildGitHubAppInstallState('account-7', {
      nonce: 'n3',
      purpose: 'account_link',
      frontendOrigin: 'https://preview.kortix.com',
    });

    const res = await githubAppSetupRouter.request(
      `/install-callback?state=${encodeURIComponent(state)}`,
    );

    expect(res.headers.get('location')).toBe(
      'https://preview.kortix.com/github/setup?github=error&reason=missing_installation_id&account_id=account-7',
    );
  });
});

describe('an install started on GitHub itself', () => {
  test('keeps its own landing, with the installation id', async () => {
    const res = await githubAppSetupRouter.request('/install-callback?installation_id=140097279');

    expect(res.headers.get('location')).toBe(
      'https://dev.kortix.com/?github=install_received&reason=direct_install&installation_id=140097279',
    );
  });
});
