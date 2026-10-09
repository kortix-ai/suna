import type { ConnectorDraftInput } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  connectorInstalledFrom,
  discoverInstallTarget,
  easyConnectInstallTarget,
  proposeAccountLabel,
  runInstall,
  type InstallDeps,
} from './install';

function fakeDeps(over: Partial<InstallDeps> = {}) {
  const calls: string[] = [];
  const drafts: ConnectorDraftInput[] = [];
  const deps: InstallDeps = {
    random: () => 'abc123',
    createConnector: async (_projectId, draft) => {
      calls.push('createConnector');
      drafts.push(draft);
      return {};
    },
    listAccountLabels: async () => {
      calls.push('listAccountLabels');
      return [];
    },
    reconcileMine: async (_projectId, input) => {
      calls.push(`reconcileMine:${input.connector_alias}:${input.label}`);
      return { connection_id: 'mine-1' };
    },
    reconcileProject: async (_projectId, input) => {
      calls.push(`reconcileProject:${input.connector_alias}:${input.label}`);
      return { connection_id: 'project-1' };
    },
    connectConnection: async (_projectId, connectionId) => {
      calls.push(`connectConnection:${connectionId}`);
      return { connected: false };
    },
    finalizeConnection: async (_projectId, connectionId) => {
      calls.push(`finalizeConnection:${connectionId}`);
      return { connected: true };
    },
    projectSteps: (_projectId, slug, label) => ({
      start: async () => {
        calls.push(`projectSteps.start:${slug}:${label}`);
        return { connected: false };
      },
      finalize: async () => {
        calls.push('projectSteps.finalize');
        return { connected: true };
      },
    }),
    runLinkFlow: async (start, finalize) => {
      calls.push('runLinkFlow');
      await start();
      await finalize();
      return { connected: true };
    },
    ...over,
  } as InstallDeps;
  return { deps, calls, drafts };
}

const managed = easyConnectInstallTarget({ slug: 'resend', name: 'Resend', provider: 'composio' });
const mcp = (auth: boolean) =>
  discoverInstallTarget('Resend', {
    id: 'resend-mcp',
    kind: 'mcp',
    name: 'Resend MCP server',
    template: {
      provider: 'mcp',
      url: 'https://mcp.example.com',
      ...(auth
        ? { auth: { type: 'bearer' as const, in: 'header' as const, name: null, prefix: null } }
        : {}),
    },
  });

describe('connectorInstalledFrom', () => {
  const resend = { slug: 'resend-abc123', provider: 'composio' as const, name: 'Resend' };

  test('matches the slug and the name Install proposes for the app, on the same provider', () => {
    expect(connectorInstalledFrom(resend, 'Resend', 'composio')).toBe(true);
  });
  test('the numbered name Install gives a later connector also matches', () => {
    expect(connectorInstalledFrom({ ...resend, name: 'Resend 2' }, 'Resend', 'composio')).toBe(
      true,
    );
    expect(connectorInstalledFrom({ ...resend, name: ' resend 12 ' }, 'Resend', 'composio')).toBe(
      true,
    );
  });
  test('another provider is another surface', () => {
    expect(connectorInstalledFrom({ ...resend, provider: 'mcp' }, 'Resend', 'composio')).toBe(
      false,
    );
  });
  test('an app whose name only starts the same is a different app', () => {
    expect(
      connectorInstalledFrom(
        { slug: 'notion-api-key-abc123', provider: 'composio', name: 'Notion API Key' },
        'Notion',
        'composio',
      ),
    ).toBe(false);
    expect(
      connectorInstalledFrom(
        { slug: 'github-abc123', provider: 'composio', name: 'GitHub' },
        'Git',
        'composio',
      ),
    ).toBe(false);
  });
  test('a six-character word tail is not a random suffix', () => {
    expect(
      connectorInstalledFrom(
        { slug: 'notion-search', provider: 'mcp', name: 'Notion Search' },
        'Notion',
        'mcp',
      ),
    ).toBe(false);
    expect(
      connectorInstalledFrom(
        { slug: 'google-sheets', provider: 'mcp', name: 'Google Sheets' },
        'Google',
        'mcp',
      ),
    ).toBe(false);
  });
  test('a renamed connector is not reused', () => {
    expect(connectorInstalledFrom({ ...resend, name: 'My mailer' }, 'Resend', 'composio')).toBe(
      false,
    );
    // `<App> 1` and `<App> 2b` are names a person wrote, not ones Install gives.
    expect(connectorInstalledFrom({ ...resend, name: 'Resend 1' }, 'Resend', 'composio')).toBe(
      false,
    );
    expect(connectorInstalledFrom({ ...resend, name: 'Resend 2b' }, 'Resend', 'composio')).toBe(
      false,
    );
  });
  test('a connector with no name is not reused', () => {
    expect(connectorInstalledFrom({ ...resend, name: '' }, 'Resend', 'composio')).toBe(false);
  });
  test('two surfaces of one app never share a connector', () => {
    const primary = { slug: 'resend-abc123', provider: 'openapi' as const, name: 'Resend' };
    const secondary = {
      slug: 'resend-rest-api-abc123',
      provider: 'openapi' as const,
      name: 'Resend REST API',
    };
    // Each surface finds the connector Install created for it.
    expect(connectorInstalledFrom(primary, 'Resend', 'openapi')).toBe(true);
    expect(connectorInstalledFrom(secondary, 'Resend REST API', 'openapi')).toBe(true);
    expect(
      connectorInstalledFrom(
        { ...secondary, name: 'Resend REST API 2' },
        'Resend REST API',
        'openapi',
      ),
    ).toBe(true);
    // Neither finds the other's.
    expect(connectorInstalledFrom(primary, 'Resend REST API', 'openapi')).toBe(false);
    expect(connectorInstalledFrom(secondary, 'Resend', 'openapi')).toBe(false);
  });
  test('a hand-written slug is never reused', () => {
    expect(
      connectorInstalledFrom(
        { slug: 'resend', provider: 'composio', name: 'Resend' },
        'Resend',
        'composio',
      ),
    ).toBe(false);
  });
});

describe('proposeAccountLabel', () => {
  test('the first account takes the app name', () => {
    expect(proposeAccountLabel('Resend', [])).toBe('Resend');
  });
  test('later accounts are numbered past every taken label, whatever the case', () => {
    expect(proposeAccountLabel('Resend', ['resend'])).toBe('Resend 2');
    expect(proposeAccountLabel('Resend', ['Resend', 'Resend 2'])).toBe('Resend 3');
  });
});

describe('runInstall', () => {
  test('opens the provider window before it creates the connector', async () => {
    const { deps, calls, drafts } = fakeDeps();
    const pending = runInstall(deps, {
      projectId: 'p1',
      target: managed,
      audience: 'private',
      connectors: [],
    });
    // Synchronous: nothing may run, let alone be awaited, before the window opens.
    expect(calls).toEqual(['runLinkFlow', 'createConnector']);
    const result = await pending;
    expect(calls[0]).toBe('runLinkFlow');
    expect(calls[1]).toBe('createConnector');
    expect(calls[2]).toBe('reconcileMine:resend-abc123:Resend');
    expect(calls[3]).toBe('connectConnection:mine-1');
    expect(calls[4]).toBe('finalizeConnection:mine-1');
    expect(calls).toHaveLength(5);
    expect(drafts[0]).toEqual({
      slug: 'resend-abc123',
      name: 'Resend',
      provider: 'composio',
      app: 'resend',
      account: 'default',
      create_only: true,
    });
    expect(result).toEqual({ status: 'connected', slug: 'resend-abc123' });
  });

  test('the label lookup for an installed app runs inside the click, after the window opens', async () => {
    const { deps, calls } = fakeDeps();
    const pending = runInstall(deps, {
      projectId: 'p1',
      target: managed,
      audience: 'project',
      connectors: [
        { slug: 'resend-zzz999', provider: 'composio', name: 'Resend', authSecret: null },
      ],
    });
    expect(calls).toEqual(['runLinkFlow', 'listAccountLabels']);
    await pending;
  });

  test('an installed app gets another account, never a second connector', async () => {
    const { deps, calls } = fakeDeps({
      listAccountLabels: async () => ['Resend'],
    });
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: managed,
      audience: 'project',
      connectors: [
        { slug: 'resend-zzz999', provider: 'composio', name: 'Resend', authSecret: null },
      ],
    });
    expect(calls).not.toContain('createConnector');
    expect(calls).toContain('projectSteps.start:resend-zzz999:Resend 2');
    expect(result).toEqual({ status: 'connected', slug: 'resend-zzz999' });
  });

  test('a renamed connector is left alone: Install creates a second one', async () => {
    const { deps, calls, drafts } = fakeDeps();
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: managed,
      audience: 'private',
      connectors: [
        { slug: 'resend-zzz999', provider: 'composio', name: 'My mailer', authSecret: null },
      ],
    });
    expect(calls).not.toContain('listAccountLabels');
    expect(calls).toContain('createConnector');
    expect(drafts[0]?.name).toBe('Resend 2');
    expect(result).toEqual({ status: 'connected', slug: 'resend-abc123' });
  });

  test('an MCP connector with auth goes to sign-in, which falls back to credential entry', async () => {
    const { deps, calls } = fakeDeps();
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: mcp(true),
      audience: 'project',
      connectors: [],
    });
    expect(calls).not.toContain('runLinkFlow');
    expect(calls).toEqual(['createConnector', 'reconcileProject:resend-abc123:Resend']);
    expect(result).toEqual({
      status: 'sign_in',
      slug: 'resend-abc123',
      connectionId: 'project-1',
    });
  });

  test('a direct connector with no auth is connected at once', async () => {
    const { deps } = fakeDeps();
    expect(
      await runInstall(deps, {
        projectId: 'p1',
        target: mcp(false),
        audience: 'private',
        connectors: [],
      }),
    ).toEqual({ status: 'connected', slug: 'resend-abc123' });
  });

  test('an existing MCP connector with a credential goes to sign-in for the new account', async () => {
    const { deps } = fakeDeps();
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: mcp(false),
      audience: 'private',
      connectors: [
        { slug: 'resend-zzz999', provider: 'mcp', name: 'Resend', authSecret: 'RESEND_TOKEN' },
      ],
    });
    expect(result).toEqual({
      status: 'sign_in',
      slug: 'resend-zzz999',
      connectionId: 'mine-1',
    });
  });

  test('a sync failure stops before any account is created', async () => {
    const { deps, calls } = fakeDeps({
      createConnector: async () => ({
        sync: { errors: [{ slug: 'resend-abc123', error: 'manifest rejected' }] },
      }),
    } as unknown as Partial<InstallDeps>);
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: mcp(true),
      audience: 'private',
      connectors: [],
    });
    expect(result).toEqual({ status: 'sync_failed', name: 'Resend', error: 'manifest rejected' });
    expect(calls.some((call) => call.startsWith('reconcile'))).toBe(false);
  });

  test('an MCP server that answers 401 goes on to sign-in, not to a failure', async () => {
    const { deps, calls } = fakeDeps({
      createConnector: async () => ({
        sync: {
          errors: [{ slug: 'resend-abc123', error: 'MCP tools/list failed: HTTP 401' }],
        },
      }),
    } as unknown as Partial<InstallDeps>);
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: mcp(false),
      audience: 'private',
      connectors: [],
    });
    expect(result).toEqual({
      status: 'sign_in',
      slug: 'resend-abc123',
      connectionId: 'mine-1',
    });
    expect(calls.some((call) => call.startsWith('reconcile'))).toBe(true);
  });

  test('installing again over an MCP connector that cannot sign in goes to sign-in', async () => {
    const { deps } = fakeDeps();
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: mcp(false),
      audience: 'private',
      connectors: [
        {
          slug: 'resend-zzz999',
          provider: 'mcp',
          name: 'Resend',
          authSecret: null,
          status: 'error',
        },
      ],
    });
    expect(result).toEqual({
      status: 'sign_in',
      slug: 'resend-zzz999',
      connectionId: 'mine-1',
    });
  });

  test('a sync failure on a managed install also reports, and the window flow ends', async () => {
    const { deps, calls } = fakeDeps({
      createConnector: async () => ({
        sync: { errors: [{ slug: 'resend-abc123', error: 'manifest rejected' }] },
      }),
    } as unknown as Partial<InstallDeps>);
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: managed,
      audience: 'private',
      connectors: [],
    });
    expect(result).toEqual({ status: 'sync_failed', name: 'Resend', error: 'manifest rejected' });
    expect(calls).toEqual(['runLinkFlow']);
  });

  test('any other failure rejects, so the caller can show it', async () => {
    const { deps } = fakeDeps({
      reconcileMine: async () => {
        throw new Error('forbidden');
      },
    });
    await expect(
      runInstall(deps, { projectId: 'p1', target: mcp(true), audience: 'private', connectors: [] }),
    ).rejects.toThrow('forbidden');
  });
});
