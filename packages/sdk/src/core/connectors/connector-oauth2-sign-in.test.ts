import { describe, expect, test } from 'bun:test';

import type { OAuth2ResourceDiscovery } from '../rest/projects-client';
import {
  buildOAuth2ClientRegistrationInput,
  oauth2AutoConnectPlan,
  startConnectionOAuth2SignIn,
  type ConnectionOAuth2SignInDeps,
  waitForConnectionOAuth2,
} from './connector-oauth2-sign-in';

const FULL: OAuth2ResourceDiscovery = {
  resource_url: 'https://api.read.ai/mcp',
  requires_authorization: true,
  resource: 'https://api.read.ai/mcp',
  resource_name: 'Read AI MCP Server',
  protected_resource_metadata_url: 'https://api.read.ai/.well-known/oauth-protected-resource/mcp',
  authorization_server: 'https://authn.read.ai/',
  metadata: {
    discovery_url: 'https://authn.read.ai/.well-known/oauth-authorization-server',
    authorization_url: 'https://authn.read.ai/oauth2/auth',
    token_url: 'https://authn.read.ai/oauth2/token',
    device_authorization_url: 'https://authn.read.ai/oauth2/device/auth',
    revocation_url: 'https://authn.read.ai/oauth2/revoke',
    resource: 'https://api.read.ai/mcp',
  },
  registration_endpoint: 'https://api.read.ai/oauth/register',
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  code_challenge_methods_supported: ['S256'],
  scopes: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
  warnings: [],
};

describe('oauth2AutoConnectPlan', () => {
  test('a fully compliant server is one click, no fields', () => {
    expect(oauth2AutoConnectPlan(FULL)).toEqual({
      kind: 'register',
      label: 'Connect Read AI MCP Server',
      registrationEndpoint: 'https://api.read.ai/oauth/register',
      scopes: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
    });
  });

  test('endpoints but no registration endpoint → the user supplies a client id', () => {
    const { registration_endpoint: _drop, ...rest } = FULL;
    expect(oauth2AutoConnectPlan(rest)).toEqual({
      kind: 'client_id_required',
      label: 'Connect Read AI MCP Server',
      scopes: FULL.scopes,
    });
  });

  test('a server that needs no authorization is not an OAuth connector', () => {
    expect(
      oauth2AutoConnectPlan({
        resource_url: 'https://open.example.com/mcp',
        requires_authorization: false,
        scopes: [],
        warnings: [],
      }),
    ).toEqual({ kind: 'no_authorization' });
  });

  test('no discoverable endpoints → manual setup', () => {
    expect(
      oauth2AutoConnectPlan({
        resource_url: 'https://api.example.com/mcp',
        requires_authorization: true,
        scopes: [],
        warnings: ['No authorization server metadata could be discovered.'],
      }),
    ).toEqual({
      kind: 'manual',
      reason: 'No authorization server metadata could be discovered.',
    });
  });

  test('null discovery (not run yet) is undecided', () => {
    expect(oauth2AutoConnectPlan(null)).toEqual({ kind: 'unknown' });
  });

  test('a resource without a name falls back to its host', () => {
    const { resource_name: _drop, ...rest } = FULL;
    expect(oauth2AutoConnectPlan(rest)).toMatchObject({ label: 'Connect api.read.ai' });
  });
});

describe('buildOAuth2ClientRegistrationInput', () => {
  test('carries every discovered endpoint, the scopes, and the resource', () => {
    expect(buildOAuth2ClientRegistrationInput(FULL)).toEqual({
      registration_endpoint: 'https://api.read.ai/oauth/register',
      issuer: 'https://authn.read.ai/',
      discovery_url: 'https://authn.read.ai/.well-known/oauth-authorization-server',
      authorization_url: 'https://authn.read.ai/oauth2/auth',
      token_url: 'https://authn.read.ai/oauth2/token',
      device_authorization_url: 'https://authn.read.ai/oauth2/device/auth',
      revocation_url: 'https://authn.read.ai/oauth2/revoke',
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      scopes: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
      resource: 'https://api.read.ai/mcp',
    });
  });

  test('throws when the server has no registration endpoint', () => {
    const { registration_endpoint: _drop, ...rest } = FULL;
    expect(() => buildOAuth2ClientRegistrationInput(rest)).toThrow('registration');
  });
});

describe('a catalogue app on a Kortix OAuth client (kortix_client)', () => {
  const GMAIL: OAuth2ResourceDiscovery = {
    resource_url: 'https://gmailmcp.googleapis.com/mcp/v1',
    requires_authorization: true,
    resource: 'https://gmailmcp.googleapis.com/mcp/v1',
    authorization_server: 'https://accounts.google.com',
    metadata: {
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.googleapis.com/token',
    },
    kortix_client: true,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    warnings: [],
  };

  test('is one click with no registration endpoint', () => {
    expect(oauth2AutoConnectPlan(GMAIL)).toEqual({
      kind: 'register',
      label: 'Connect gmailmcp.googleapis.com',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
  });

  test('registers without a registration endpoint, so the API uses its own client', () => {
    const input = buildOAuth2ClientRegistrationInput(GMAIL);
    expect(input).not.toHaveProperty('registration_endpoint');
    expect(input.token_url).toBe('https://oauth2.googleapis.com/token');
  });
});

// ─── One sign-in start for a host without a page to return to (the TUI) ─────

function recording(discovery: OAuth2ResourceDiscovery, options: { deviceFails?: boolean } = {}) {
  const calls: string[] = [];
  let polls = 0;
  const deps: ConnectionOAuth2SignInDeps = {
    discover: async (_p, c) => {
      calls.push(`discover:${c}`);
      return { discovery };
    },
    register: async (_p, c, input) => {
      calls.push(`register:${c}:${input.registration_endpoint ?? 'kortix'}`);
      return { application: {} as never };
    },
    authorize: async (_p, c, input) => {
      calls.push(`authorize:${c}:${input.success_redirect_uri}`);
      return { authorization_url: 'https://auth.example/authorize?x=1', expires_at: '2026-11-04T00:10:00Z' };
    },
    device: async (_p, c) => {
      calls.push(`device:${c}`);
      if (options.deviceFails) throw new Error('device flow refused');
      return {
        session_id: 's-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.example/device',
        expires_at: '2026-11-04T00:10:00Z',
        interval_seconds: 5,
      };
    },
    pollDevice: async (_p, c, s) => {
      polls += 1;
      calls.push(`poll-device:${c}:${s}`);
      return { status: polls < 3 ? 'pending' : 'active' };
    },
    status: async (_p, c) => {
      polls += 1;
      calls.push(`status:${c}`);
      return { status: polls < 2 ? 'pending' : 'active' };
    },
  };
  return { calls, deps };
}

describe('startConnectionOAuth2SignIn', () => {
  test('a server with a device endpoint registers, then shows a code', async () => {
    const { calls, deps } = recording(FULL);
    const start = await startConnectionOAuth2SignIn('p-1', 'c-1', { returnUrl: 'https://app.example/x', deps });
    expect(start).toEqual({
      kind: 'device',
      sessionId: 's-1',
      userCode: 'ABCD-EFGH',
      url: 'https://auth.example/device',
      expiresAt: '2026-11-04T00:10:00Z',
      intervalSeconds: 5,
    });
    expect(calls).toEqual(['discover:c-1', 'register:c-1:https://api.read.ai/oauth/register', 'device:c-1']);
  });

  test('a refused device start falls back to the browser authorization', async () => {
    const { calls, deps } = recording(FULL, { deviceFails: true });
    const start = await startConnectionOAuth2SignIn('p-1', 'c-1', { returnUrl: 'https://app.example/x', deps });
    expect(start).toEqual({ kind: 'browser', url: 'https://auth.example/authorize?x=1', expiresAt: '2026-11-04T00:10:00Z' });
    expect(calls.at(-1)).toBe('authorize:c-1:https://app.example/x');
  });

  test('without a device endpoint it is the authorization URL', async () => {
    const discovery = { ...FULL, metadata: { ...FULL.metadata, device_authorization_url: undefined } };
    const { calls, deps } = recording(discovery);
    const start = await startConnectionOAuth2SignIn('p-1', 'c-1', { returnUrl: 'https://app.example/x', deps });
    expect(start.kind).toBe('browser');
    expect(calls).not.toContain('device:c-1');
  });

  test('a server that needs no authorization has nothing to sign in', async () => {
    const { calls, deps } = recording({ ...FULL, requires_authorization: false });
    expect(await startConnectionOAuth2SignIn('p-1', 'c-1', { deps })).toEqual({ kind: 'none' });
    expect(calls).toEqual(['discover:c-1']);
  });

  test('no dynamic registration: unavailable, with the reason, and nothing registered', async () => {
    const { calls, deps } = recording({ ...FULL, registration_endpoint: undefined });
    const start = await startConnectionOAuth2SignIn('p-1', 'c-1', { deps });
    expect(start.kind).toBe('unavailable');
    expect(calls).toEqual(['discover:c-1']);
  });
});

describe('waitForConnectionOAuth2', () => {
  test('a device code polls its session at the server interval until active', async () => {
    const { calls, deps } = recording(FULL);
    const slept: number[] = [];
    await expect(
      waitForConnectionOAuth2(
        'p-1',
        'c-1',
        { kind: 'device', sessionId: 's-1', userCode: 'X', url: 'u', expiresAt: '', intervalSeconds: 5 },
        { deps, sleep: async (ms) => void slept.push(ms), now: () => 0 },
      ),
    ).resolves.toEqual({ connected: true });
    expect(calls.filter((c) => c.startsWith('poll-device'))).toHaveLength(3);
    expect(slept).toEqual([5000, 5000]);
  });

  test('a browser authorization polls the connection status every 2 s', async () => {
    const { calls, deps } = recording(FULL);
    const slept: number[] = [];
    await waitForConnectionOAuth2('p-1', 'c-1', { kind: 'browser', url: 'u', expiresAt: '' }, {
      deps,
      sleep: async (ms) => void slept.push(ms),
      now: () => 0,
    });
    expect(calls).toEqual(['status:c-1', 'status:c-1']);
    expect(slept).toEqual([2000]);
  });

  test('an error status ends the wait with the server code', async () => {
    const { deps } = recording(FULL);
    deps.status = async () => ({ status: 'error', error_code: 'access_denied' });
    await expect(
      waitForConnectionOAuth2('p-1', 'c-1', { kind: 'browser', url: 'u', expiresAt: '' }, { deps, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow('access_denied');
  });

  test('an expired device code ends the wait', async () => {
    const { deps } = recording(FULL);
    deps.pollDevice = async () => ({ status: 'expired' }) as never;
    await expect(
      waitForConnectionOAuth2(
        'p-1',
        'c-1',
        { kind: 'device', sessionId: 's-1', userCode: 'X', url: 'u', expiresAt: '', intervalSeconds: 5 },
        { deps, sleep: async () => {}, now: () => 0 },
      ),
    ).rejects.toThrow('The sign-in code expired. Start again.');
  });

  test('times out after 10 minutes', async () => {
    const { deps } = recording(FULL);
    deps.status = async () => ({ status: 'pending' });
    let now = 0;
    await expect(
      waitForConnectionOAuth2('p-1', 'c-1', { kind: 'browser', url: 'u', expiresAt: '' }, {
        deps,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    ).rejects.toThrow('Authorization timed out after 10 minutes. Try again.');
  });

  test('an abort stops the wait', async () => {
    const { deps } = recording(FULL);
    deps.status = async () => ({ status: 'pending' });
    const controller = new AbortController();
    const wait = waitForConnectionOAuth2('p-1', 'c-1', { kind: 'browser', url: 'u', expiresAt: '' }, {
      deps,
      signal: controller.signal,
      sleep: async () => {
        controller.abort(new Error('cancelled'));
      },
      now: () => 0,
    });
    await expect(wait).rejects.toThrow('cancelled');
  });
});
