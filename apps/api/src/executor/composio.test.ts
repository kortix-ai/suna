import { describe, expect, test } from 'bun:test';

import { config } from '../config';
import {
  authorizeComposioToolkitSession,
  composioConfigured,
  createComposioToolkitSession,
  deleteComposioSession,
  listComposioToolkits,
  listComposioTools,
} from './composio';

function withComposioConfig(
  values: { apiKey: string; enabled: boolean },
  assertion: () => void,
): void {
  const originalApiKey = config.COMPOSIO_API_KEY;
  const originalEnabled = config.COMPOSIO_ENABLED;
  try {
    config.COMPOSIO_API_KEY = values.apiKey;
    config.COMPOSIO_ENABLED = values.enabled;
    assertion();
  } finally {
    config.COMPOSIO_API_KEY = originalApiKey;
    config.COMPOSIO_ENABLED = originalEnabled;
  }
}

describe('Composio catalogue adapter', () => {
  test('is not configured without an API key', () => {
    withComposioConfig({ apiKey: '', enabled: true }, () => {
      expect(composioConfigured()).toBe(false);
    });
  });

  test('defaults to configured with an API key and respects the explicit disable flag', () => {
    withComposioConfig({ apiKey: 'test-only', enabled: true }, () => {
      expect(composioConfigured()).toBe(true);
    });
    withComposioConfig({ apiKey: 'test-only', enabled: false }, () => {
      expect(composioConfigured()).toBe(false);
    });
  });

  test('preserves toolkit pagination and forwards search and cursor', async () => {
    const calls: unknown[] = [];
    const catalogue = {
      listToolkitPage: async (params: unknown) => {
        calls.push(params);
        return {
          items: [
            {
              slug: 'github',
              name: 'GitHub',
              no_auth: false,
              meta: {
                description: 'Code hosting',
                logo: 'https://logos.composio.dev/api/github',
                tools_count: 871,
                categories: [{ slug: 'developer-tools', name: 'Developer tools' }],
              },
            },
          ],
          next_cursor: 'page-3',
        };
      },
      listToolPage: async () => ({ items: [] }),
    };

    const page = await listComposioToolkits({ q: 'git hub', cursor: 'page-2' }, catalogue as never);

    expect(calls).toEqual([
      {
        managed_by: 'all',
        sort_by: 'usage',
        limit: 48,
        search: 'git hub',
        cursor: 'page-2',
      },
    ]);
    expect(page).toEqual({
      toolkits: [
        {
          slug: 'github',
          name: 'GitHub',
          description: 'Code hosting',
          iconUrl: 'https://logos.composio.dev/api/github',
          authRequired: true,
          toolsCount: 871,
          categories: ['Developer tools'],
          mcpUrl: null,
        },
      ],
      nextCursor: 'page-3',
      hasMore: true,
    });
  });

  test('filters short toolkit searches locally without sending an invalid upstream query', async () => {
    const calls: unknown[] = [];
    const catalogue = {
      listToolkitPage: async (params: unknown) => {
        calls.push(params);
        return {
          items: [
            { slug: 'github', name: 'GitHub', no_auth: false, meta: {} },
            { slug: 'gmail', name: 'Gmail', no_auth: false, meta: {} },
          ],
          next_cursor: 'page-2',
        };
      },
      listToolPage: async () => ({ items: [] }),
    };

    const page = await listComposioToolkits({ q: 'gi' }, catalogue as never);

    expect(calls).toEqual([{ managed_by: 'all', sort_by: 'usage', limit: 48 }]);
    expect(page.toolkits.map((toolkit) => toolkit.slug)).toEqual(['github']);
    expect(page.hasMore).toBe(true);
  });

  test('preserves tool pagination and maps raw no_auth fields', async () => {
    const calls: unknown[] = [];
    const catalogue = {
      listToolkitPage: async () => ({ items: [] }),
      listToolPage: async (params: unknown) => {
        calls.push(params);
        return {
          items: [
            {
              slug: 'GITHUB_CREATE_ISSUE',
              name: 'Create an issue',
              description: 'Creates a GitHub issue.',
              no_auth: false,
              toolkit: { slug: 'github' },
            },
          ],
          next_cursor: 'tools-3',
        };
      },
    };

    const page = await listComposioTools(
      { toolkitSlug: 'github', q: 'create issue', cursor: 'tools-2' },
      catalogue as never,
    );

    expect(calls).toEqual([
      {
        toolkit_slug: 'github',
        toolkit_versions: 'latest',
        limit: 48,
        query: 'create issue',
        cursor: 'tools-2',
      },
    ]);
    expect(page).toEqual({
      tools: [
        {
          slug: 'GITHUB_CREATE_ISSUE',
          name: 'Create an issue',
          description: 'Creates a GitHub issue.',
          toolkitSlug: 'github',
          authRequired: true,
        },
      ],
      nextCursor: 'tools-3',
      hasMore: true,
    });
  });
});

describe('Composio Tool Router sessions', () => {
  test('creates a project-scoped MCP session with every toolkit tool preloaded', async () => {
    const calls: unknown[] = [];
    const session = {
      sessionId: 'trs_123',
      mcp: {
        url: 'https://backend.composio.dev/tool_router/trs_123/mcp',
        headers: { 'x-api-key': 'must-not-leave-the-server' },
      },
      toolkits: async (input: unknown) => {
        calls.push(['toolkits', input]);
        return {
          items: [{ slug: 'hackernews', name: 'Hacker News', isNoAuth: true }],
        };
      },
      authorize: async () => {
        throw new Error('not expected');
      },
      delete: async () => ({ sessionId: 'trs_123', deleted: true as const }),
    };
    const client = {
      create: async (userId: string, input: unknown) => {
        calls.push(['create', userId, input]);
        return session;
      },
      use: async () => session,
    };

    const callbackUrl = 'https://app.kortix.com/projects/project-1/customize/connectors';
    const result = await createComposioToolkitSession(
      { projectId: 'project-1', toolkitSlug: 'hackernews', callbackUrl },
      client as never,
    );

    expect(calls).toEqual([
      [
        'create',
        'kortix-project-project-1',
        {
          toolkits: ['hackernews'],
          preload: { tools: 'all' },
          manageConnections: {
            enable: true,
            callbackUrl,
            waitForConnections: false,
          },
          sandbox: { enable: false },
          mcp: true,
        },
      ],
      ['toolkits', { toolkits: ['hackernews'], limit: 1 }],
    ]);
    expect(result).toEqual({
      sessionId: 'trs_123',
      mcpUrl: 'https://backend.composio.dev/tool_router/trs_123/mcp',
      credentialHeaderName: 'x-api-key',
      requiresAuthorization: false,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leave-the-server');
  });

  test('starts authorization only for a retained session and returns its redirect URL', async () => {
    const calls: unknown[] = [];
    const session = {
      sessionId: 'trs_456',
      mcp: {
        url: 'https://backend.composio.dev/tool_router/trs_456/mcp',
        headers: { 'x-api-key': 'server-only' },
      },
      toolkits: async () => ({
        items: [
          {
            slug: 'github',
            name: 'GitHub',
            isNoAuth: false,
            connection: { isActive: false },
          },
        ],
      }),
      authorize: async (toolkitSlug: string, options: unknown) => {
        calls.push(['authorize', toolkitSlug, options]);
        return { redirectUrl: 'https://accounts.composio.dev/connect/ca_123' };
      },
      delete: async () => {
        calls.push(['delete']);
        return { sessionId: 'trs_456', deleted: true as const };
      },
    };
    const client = {
      create: async () => session,
      use: async (sessionId: string, options: unknown) => {
        calls.push(['use', sessionId, options]);
        return session;
      },
    };

    const prepared = await createComposioToolkitSession(
      {
        projectId: 'project-1',
        toolkitSlug: 'github',
        callbackUrl: 'https://app.kortix.com/projects/project-1/customize/connectors',
      },
      client as never,
    );
    expect(prepared.requiresAuthorization).toBe(true);

    await expect(
      authorizeComposioToolkitSession(
        {
          sessionId: prepared.sessionId,
          toolkitSlug: 'github',
          callbackUrl: 'https://app.kortix.com/projects/project-1/customize/connectors',
        },
        client as never,
      ),
    ).resolves.toBe('https://accounts.composio.dev/connect/ca_123');
    await deleteComposioSession(prepared.sessionId, client as never);
    expect(calls).toContainEqual([
      'authorize',
      'github',
      {
        callbackUrl: 'https://app.kortix.com/projects/project-1/customize/connectors',
      },
    ]);
    expect(calls).toContainEqual(['delete']);
  });
});
