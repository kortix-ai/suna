import { describe, expect, test } from 'bun:test';

import { addMcpServer, mcpServerIdentity, type AddMcpServerDeps } from './add-mcp-server';

/**
 * KRTX-2185: adding an MCP server took 8 steps (New → custom connector → type
 * a slug → switch the provider to MCP → URL → Add → Sign in → name the
 * account), and every new connector got an empty "Everyone in project"
 * account whose Connect signed a personal login into the shared account. The
 * fast path asks for the URL and who may use it ("Only you" by default), and
 * goes straight to the server's sign-in.
 */
describe('mcpServerIdentity', () => {
  test('names the server after its domain, not the "mcp" host label or the TLD', () => {
    expect(mcpServerIdentity('https://mcp.linear.app/mcp', [])).toEqual({ slug: 'linear', name: 'Linear' });
    expect(mcpServerIdentity('https://mcp.deepwiki.com/mcp', [])).toEqual({ slug: 'deepwiki', name: 'Deepwiki' });
    expect(mcpServerIdentity('https://mcp.sentry.dev/mcp', [])).toEqual({ slug: 'sentry', name: 'Sentry' });
    expect(mcpServerIdentity('https://api.example.co.uk/v1/mcp', [])).toEqual({ slug: 'example', name: 'Example' });
    expect(mcpServerIdentity('http://localhost:8787/mcp', [])).toEqual({ slug: 'localhost', name: 'Localhost' });
  });

  test('a taken slug gets the next free number', () => {
    expect(mcpServerIdentity('https://mcp.linear.app/mcp', ['linear', 'linear-2'])?.slug).toBe('linear-3');
  });

  test('anything that is not an http(s) URL is refused', () => {
    expect(mcpServerIdentity('linear', [])).toBeNull();
    expect(mcpServerIdentity('ftp://mcp.linear.app', [])).toBeNull();
    expect(mcpServerIdentity('', [])).toBeNull();
  });
});

function fakes(
  over: Partial<{
    signInPending: boolean;
    syncError: string | null;
    signInUrl: string | null;
    projectSlot: boolean;
  }> = {},
) {
  const calls: string[] = [];
  const drafts: Array<Record<string, unknown>> = [];
  const deps: AddMcpServerDeps = {
    createConnector: async (_projectId, draft) => {
      drafts.push(draft as unknown as Record<string, unknown>);
      calls.push('create');
      return { syncError: over.syncError ?? null, signInPending: over.signInPending ?? true };
    },
    createMemberAccount: async (_projectId, input) => {
      calls.push(`member:${input.connector_alias}:${input.label}`);
      return { connection_id: 'conn-me' };
    },
    projectAccount: async (_projectId, slug, label) => {
      calls.push(`project:${slug}:${label}`);
      return { connection_id: over.projectSlot === false ? 'conn-new' : 'conn-slot' };
    },
    grantAccess: async (_projectId, connectionId, grantees) => {
      calls.push(`grant:${connectionId}:${grantees.map((g) => `${g.type}:${g.id}`).join(',')}`);
    },
    startSignIn: async (_projectId, connectionId) => {
      calls.push(`sign-in:${connectionId}`);
      return over.signInUrl === undefined ? 'https://mcp.linear.app/authorize?x=1' : over.signInUrl;
    },
  };
  return { deps, calls, drafts };
}

describe('addMcpServer', () => {
  test('"Only you" makes no shared account and signs in a private one', async () => {
    const { deps, calls, drafts } = fakes();
    const result = await addMcpServer(
      'p1',
      { url: 'https://mcp.linear.app/mcp', audience: 'private', takenSlugs: [], returnUrl: () => 'http://app/x' },
      deps,
    );
    expect(drafts[0]).toMatchObject({
      slug: 'linear',
      name: 'Linear',
      provider: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      authorization_strategy: 'user',
    });
    expect(calls).toEqual(['create', 'member:linear:Linear', 'sign-in:conn-me']);
    expect(result).toEqual({
      slug: 'linear',
      name: 'Linear',
      connectionId: 'conn-me',
      signInUrl: 'https://mcp.linear.app/authorize?x=1',
      signInError: null,
      syncError: null,
    });
  });

  test('"Everyone in the project" signs in the project account', async () => {
    const { deps, calls, drafts } = fakes();
    await addMcpServer(
      'p1',
      { url: 'https://mcp.linear.app/mcp', audience: 'project', takenSlugs: [], returnUrl: () => 'http://app/x' },
      deps,
    );
    expect(drafts[0]?.authorization_strategy).toBe('project');
    expect(calls).toEqual(['create', 'project:linear:Linear', 'sign-in:conn-slot']);
  });

  test('"Specific people" narrows the project account before it is signed in', async () => {
    const { deps, calls, drafts } = fakes();
    await addMcpServer(
      'p1',
      {
        url: 'https://mcp.linear.app/mcp',
        audience: 'members',
        grantees: [
          { type: 'user', id: 'u1' },
          { type: 'group', id: 'g1' },
        ],
        takenSlugs: [],
        returnUrl: () => 'http://app/x',
      },
      deps,
    );
    expect(drafts[0]?.authorization_strategy).toBe('project');
    expect(calls).toEqual([
      'create',
      'project:linear:Linear',
      'grant:conn-slot:user:u1,group:g1',
      'sign-in:conn-slot',
    ]);
  });

  test('a server that needs no sign-in is ready as soon as its account exists', async () => {
    const { deps, calls } = fakes({ signInPending: false });
    const result = await addMcpServer(
      'p1',
      { url: 'https://mcp.deepwiki.com/mcp', audience: 'private', takenSlugs: [], returnUrl: () => 'http://app/x' },
      deps,
    );
    expect(calls).toEqual(['create', 'member:deepwiki:Deepwiki']);
    expect(result.signInUrl).toBeNull();
  });

  test('a 401 with no WWW-Authenticate challenge still tries the sign-in', async () => {
    // The create reads the auth scheme from the challenge header only. The
    // server-side discovery also tries the well-known metadata URLs, so the
    // sign-in can start without the header.
    const { deps, calls } = fakes({ signInPending: false, syncError: 'MCP tools/list failed: HTTP 401' });
    const result = await addMcpServer(
      'p1',
      { url: 'https://mcp.linear.app/mcp', audience: 'private', takenSlugs: [], returnUrl: () => 'x' },
      deps,
    );
    expect(calls).toEqual(['create', 'member:linear:Linear', 'sign-in:conn-me']);
    expect(result.signInUrl).toBe('https://mcp.linear.app/authorize?x=1');
    expect(result.syncError).toBeNull();
  });

  test('a 401 with no one-click sign-in keeps the error for credential entry', async () => {
    const { deps } = fakes({
      signInPending: false,
      syncError: 'MCP tools/list failed: HTTP 401',
      signInUrl: null,
    });
    const result = await addMcpServer(
      'p1',
      { url: 'https://mcp.example.com/mcp', audience: 'private', takenSlugs: [], returnUrl: () => 'x' },
      deps,
    );
    expect(result).toMatchObject({ signInUrl: null, signInError: null, syncError: 'MCP tools/list failed: HTTP 401' });
  });

  test('a sign-in that cannot start keeps the account and says why', async () => {
    const { deps, calls } = fakes();
    deps.startSignIn = async () => {
      throw new Error('OAuth2 client registration failed (400): invalid_redirect_uri');
    };
    const result = await addMcpServer(
      'p1',
      { url: 'https://mcp.linear.app/mcp', audience: 'private', takenSlugs: [], returnUrl: () => 'x' },
      deps,
    );
    expect(calls).toEqual(['create', 'member:linear:Linear']);
    expect(result.signInUrl).toBeNull();
    expect(result.connectionId).toBe('conn-me');
    expect(result.signInError).toBe('OAuth2 client registration failed (400): invalid_redirect_uri');
  });

  test('a bad URL is refused before anything is created', async () => {
    const { deps, calls } = fakes();
    await expect(
      addMcpServer('p1', { url: 'not a url', audience: 'private', takenSlugs: [], returnUrl: () => 'x' }, deps),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
