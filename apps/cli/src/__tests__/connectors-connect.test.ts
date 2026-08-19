import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runConnectors } from '../commands/connectors.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;
const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
] as const;

let saved: Record<string, string | undefined>;
let stdout = '';
let requests: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_CLI_TOKEN = 'kortix_pat_test';
  process.env.KORTIX_API_URL = 'https://api.test/v1';
  process.env.KORTIX_PROJECT_ID = 'project-1';
  process.env.KORTIX_SESSION_ID = 'session-1';
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';

  stdout = '';
  requests = [];
  (process.stdout as any).write = (chunk: unknown) => ((stdout += String(chunk)), true);
  (process.stderr as any).write = (_chunk: unknown) => true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    requests.push({ url: String(input), method: init?.method ?? 'GET', body });
    return new Response(
      JSON.stringify({
        url: 'https://app.test/connect/ksl_1',
        slug: 'github',
        app: 'github',
        expires_at: '2026-08-05T23:00:00.000Z',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
  (process.stderr as any).write = ORIGINAL_STDERR_WRITE;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('kortix connectors connect', () => {
  test('always mints one auto-finalizing connection URL', async () => {
    const code = await runConnectors(['connect', 'github', '--json']);

    expect(code).toBe(0);
    expect(requests).toEqual([
      {
        url: 'https://api.test/v1/projects/project-1/connect-requests',
        method: 'POST',
        body: { slug: 'github' },
      },
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      url: 'https://app.test/connect/ksl_1',
      slug: 'github',
    });
  });

  test('--expires configures the same connection request', async () => {
    const code = await runConnectors(['connect', 'github', '--expires', '45', '--json']);

    expect(code).toBe(0);
    expect(requests[0]?.body).toEqual({ slug: 'github', expires_in_minutes: 45 });
  });
});

describe('kortix connectors show', () => {
  test('uses the provider-specific empty-catalog remedy', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          connectors: [
            {
              slug: 'remote-tools',
              name: 'Remote tools',
              provider: 'mcp',
              status: 'active',
              credentialMode: 'shared',
              actions: [],
              authSecret: null,
              secretSet: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const code = await runConnectors(['show', 'remote-tools']);

    expect(code).toBe(0);
    expect(stdout).toContain('No tools materialized yet');
    expect(stdout).not.toContain('Add --spec to define HTTP actions');
  });
});

describe('kortix connectors connections', () => {
  test('lists canonical connections as JSON', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: undefined });
      return new Response(
        JSON.stringify({
          connections: [
            {
              connection_id: '11111111-1111-4111-8111-111111111111',
              connector_alias: 'github',
              owner_type: 'project',
              owner_id: null,
              label: 'Engineering',
              status: 'active',
              is_default: true,
              metadata: {},
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const code = await runConnectors(['connections', 'ls', '--json']);

    expect(code).toBe(0);
    expect(requests).toEqual([
      {
        url: 'https://api.test/v1/projects/project-1/connections',
        method: 'GET',
        body: undefined,
      },
    ]);
    expect(JSON.parse(stdout).connections[0]).toMatchObject({
      connection_id: '11111111-1111-4111-8111-111111111111',
      connector_alias: 'github',
      label: 'Engineering',
    });
  });

  test('creates a project connection with canonical fields', async () => {
    const code = await runConnectors([
      'connections',
      'add',
      'github',
      'Engineering',
      '--owner',
      'project',
      '--metadata',
      '{"team":"platform"}',
      '--json',
    ]);

    expect(code).toBe(0);
    expect(requests).toEqual([
      {
        url: 'https://api.test/v1/projects/project-1/connections',
        method: 'POST',
        body: {
          connector_alias: 'github',
          owner_type: 'project',
          label: 'Engineering',
          metadata: { team: 'platform' },
        },
      },
    ]);
  });

  test('lists the manage-gated roster through --all', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: undefined });
      return Response.json({ connections: [] });
    }) as typeof fetch;

    expect(await runConnectors(['connections', 'ls', '--all', '--json'])).toBe(0);
    expect(requests[0]).toEqual({
      url: 'https://api.test/v1/projects/project-1/connections/all',
      method: 'GET',
      body: undefined,
    });
  });

  test('derives member ownership through the protected --mine route', async () => {
    expect(
      await runConnectors([
        'connections',
        'add',
        'github',
        'Personal',
        '--mine',
        '--metadata',
        '{"account":"personal"}',
        '--json',
      ]),
    ).toBe(0);
    expect(requests[0]).toEqual({
      url: 'https://api.test/v1/projects/project-1/connections/me',
      method: 'POST',
      body: {
        connector_alias: 'github',
        label: 'Personal',
        metadata: { account: 'personal' },
      },
    });
  });

  test('rejects invalid metadata before sending a request', async () => {
    expect(
      await runConnectors([
        'connections',
        'add',
        'github',
        'Engineering',
        '--metadata',
        '["not-an-object"]',
      ]),
    ).toBe(2);
    expect(requests).toHaveLength(0);
  });

  test('updates credentials and every connection state action by id', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    expect(await runConnectors(['connections', 'credential', connectionId, 'secret-value'])).toBe(0);
    expect(await runConnectors(['connections', 'revoke', connectionId])).toBe(0);
    expect(await runConnectors(['connections', 'activate', connectionId])).toBe(0);
    expect(await runConnectors(['connections', 'default', connectionId])).toBe(0);

    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: `https://api.test/v1/projects/project-1/connections/${connectionId}/credential`,
        method: 'PUT',
        body: { value: 'secret-value' },
      },
      {
        url: `https://api.test/v1/projects/project-1/connections/${connectionId}/revoke`,
        method: 'PUT',
        body: {},
      },
      {
        url: `https://api.test/v1/projects/project-1/connections/${connectionId}/activate`,
        method: 'PUT',
        body: {},
      },
      {
        url: `https://api.test/v1/projects/project-1/connections/${connectionId}/default`,
        method: 'PUT',
        body: {},
      },
    ]);
  });

  test('starts and finalizes Pipedream for one connection', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      requests.push({ url: String(input), method: init?.method ?? 'GET', body });
      const payload = String(input).endsWith('/connect/finalize')
        ? { connected: true, accountId: 'apn_1' }
        : { connectUrl: 'https://pipedream.test/connect', app: 'github' };
      return Response.json(payload);
    }) as typeof fetch;

    expect(
      await runConnectors([
        'connections',
        'connect',
        connectionId,
        '--success-redirect',
        'https://app.test/success',
        '--error-redirect',
        'https://app.test/error',
        '--json',
      ]),
    ).toBe(0);
    expect(await runConnectors(['connections', 'finalize', connectionId, '--json'])).toBe(0);
    expect(requests).toEqual([
      {
        url: `https://api.test/v1/projects/project-1/connections/${connectionId}/connect`,
        method: 'POST',
        body: {
          success_redirect_uri: 'https://app.test/success',
          error_redirect_uri: 'https://app.test/error',
        },
      },
      {
        url: `https://api.test/v1/projects/project-1/connections/${connectionId}/connect/finalize`,
        method: 'POST',
        body: {},
      },
    ]);
  });
});
