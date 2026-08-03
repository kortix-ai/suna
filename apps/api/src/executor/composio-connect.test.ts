import { describe, expect, test } from 'bun:test';

import { connectComposioToolkitConnector } from './composio-connect';

function setup(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const deps = {
    createSession: async (request: unknown) => {
      calls.push(['create-session', request]);
      return {
        sessionId: 'trs_123',
        mcpUrl: 'https://backend.composio.dev/tool_router/trs_123/mcp',
        credentialHeaderName: 'x-api-key',
        requiresAuthorization: false,
      };
    },
    authorizeSession: async () => 'https://accounts.composio.dev/connect/ca_123',
    deleteSession: async (sessionId: string) => {
      calls.push(['delete-session', sessionId]);
    },
    createConnector: async (_projectId: string, _accountId: string, draft: unknown) => {
      calls.push(['create-connector', draft]);
      return { ok: true as const, sync: { synced: 1, errors: [] } };
    },
    setCredential: async (_projectId: string, slug: string, input: unknown) => {
      calls.push(['set-credential', slug, input]);
      return { ok: true as const };
    },
    syncConnectors: async () => {
      calls.push(['sync']);
      return { synced: 1, errors: [] };
    },
    deleteConnector: async (_projectId: string, slug: string) => {
      calls.push(['delete-connector', slug]);
      return { ok: true as const };
    },
    ...overrides,
  };
  return { calls, deps };
}

const input = {
  projectId: 'project-1',
  accountId: 'account-1',
  toolkitSlug: 'hackernews',
  connectorSlug: 'hacker-news',
  name: 'Hacker News',
  callbackUrl: 'https://app.kortix.com/projects/project-1/customize/connectors',
  apiKey: 'server-only-key',
};

describe('connectComposioToolkitConnector', () => {
  test('creates a credentialed MCP connector without returning the deployment key', async () => {
    const { calls, deps } = setup();

    const result = await connectComposioToolkitConnector(input, deps as never);

    expect(calls).toEqual([
      [
        'create-session',
        {
          projectId: 'project-1',
          toolkitSlug: 'hackernews',
          callbackUrl: 'https://app.kortix.com/projects/project-1/customize/connectors',
        },
      ],
      [
        'create-connector',
        {
          slug: 'hacker-news',
          name: 'Hacker News',
          provider: 'mcp',
          url: 'https://backend.composio.dev/tool_router/trs_123/mcp',
          transport: 'http',
          authorization_strategy: 'project',
          create_only: true,
          auth: { type: 'api_key', in: 'header', name: 'x-api-key' },
        },
      ],
      ['set-credential', 'hacker-news', { value: 'server-only-key' }],
      ['sync'],
    ]);
    expect(result).toEqual({
      ok: true,
      connectorSlug: 'hacker-news',
      connected: true,
      authorizationUrl: null,
      sync: { synced: 1, errors: [] },
    });
    expect(JSON.stringify(result)).not.toContain('server-only-key');
  });

  test('returns an authorization URL after an auth-required connector synchronizes', async () => {
    const { calls, deps } = setup({
      createSession: async () => ({
        sessionId: 'trs_456',
        mcpUrl: 'https://backend.composio.dev/tool_router/trs_456/mcp',
        credentialHeaderName: 'x-api-key',
        requiresAuthorization: true,
      }),
      authorizeSession: async (request: unknown) => {
        calls.push(['authorize', request]);
        return 'https://accounts.composio.dev/connect/ca_123';
      },
    });

    const result = await connectComposioToolkitConnector(
      {
        ...input,
        toolkitSlug: 'slack',
        connectorSlug: 'composio-slack',
        name: 'Slack',
      },
      deps as never,
    );

    expect(result).toMatchObject({
      ok: true,
      connectorSlug: 'composio-slack',
      connected: false,
      authorizationUrl: 'https://accounts.composio.dev/connect/ca_123',
    });
    expect(JSON.stringify(result)).not.toContain('server-only-key');
    expect(calls.at(-1)).toEqual([
      'authorize',
      {
        sessionId: 'trs_456',
        toolkitSlug: 'slack',
        callbackUrl: input.callbackUrl,
      },
    ]);
  });

  test('rolls back the connector and session when authenticated MCP sync fails', async () => {
    const { calls, deps } = setup({
      syncConnectors: async () => ({
        synced: 1,
        errors: [{ slug: 'hacker-news', error: 'upstream included a private token' }],
      }),
    });

    const result = await connectComposioToolkitConnector(input, deps as never);

    expect(result).toEqual({
      ok: false,
      error: 'Composio connector could not synchronize',
      status: 502,
    });
    expect(calls).toContainEqual(['delete-connector', 'hacker-news']);
    expect(calls).toContainEqual(['delete-session', 'trs_123']);
    expect(JSON.stringify(result)).not.toContain('private token');
  });

  test('deletes the Composio session when manifest creation throws', async () => {
    const { calls, deps } = setup({
      createConnector: async () => {
        throw new Error('git transport failed');
      },
    });

    await expect(connectComposioToolkitConnector(input, deps as never)).rejects.toThrow(
      'git transport failed',
    );
    expect(calls).toContainEqual(['delete-session', 'trs_123']);
    expect(calls.some((call) => Array.isArray(call) && call[0] === 'delete-connector')).toBe(false);
  });
});
