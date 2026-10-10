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
  const drafts: ConnectorDraftInput[] = [];
  const deps: InstallDeps = {
    random: () => 'abc123',
    createConnector: async (_projectId, draft) => {
      drafts.push(draft);
      return {};
    },
    ...over,
  };
  return { deps, drafts };
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
  test('adds the connector profile with no audience on it', async () => {
    for (const target of [mcp(false), mcp(true), managed]) {
      const { deps, drafts } = fakeDeps();
      const result = await runInstall(deps, { projectId: 'p1', target, connectors: [] });
      expect(result).toEqual({ status: 'installed', slug: 'resend-abc123' });
      expect(drafts).toHaveLength(1);
      // Who may use an account is chosen per account, never on the profile.
      expect(drafts[0]?.authorization_strategy).toBeUndefined();
    }
  });

  test('an app the project already has reuses its profile, never a second one', async () => {
    const { deps, drafts } = fakeDeps();
    const result = await runInstall(deps, {
      projectId: 'p1',
      target: mcp(false),
      connectors: [{ slug: 'resend-zzz999', provider: 'mcp', name: 'Resend' }],
    });
    expect(result).toEqual({ status: 'installed', slug: 'resend-zzz999' });
    expect(drafts).toHaveLength(0);
  });

  test('a renamed connector is left alone: Install adds a second profile', async () => {
    const { deps, drafts } = fakeDeps();
    await runInstall(deps, {
      projectId: 'p1',
      target: mcp(false),
      connectors: [{ slug: 'resend-zzz999', provider: 'mcp', name: 'Billing mail' }],
    });
    expect(drafts).toHaveLength(1);
  });

  test('an MCP server that answers 401 is installed: the sign-in comes with the account', async () => {
    const { deps } = fakeDeps({
      createConnector: async () => ({
        sync: { errors: [{ slug: 'resend-abc123', error: 'MCP tools/list failed: HTTP 401' }] },
      }),
    } as Partial<InstallDeps>);
    expect(await runInstall(deps, { projectId: 'p1', target: mcp(false), connectors: [] })).toEqual(
      { status: 'installed', slug: 'resend-abc123' },
    );
  });

  test('any other sync failure is reported', async () => {
    const { deps } = fakeDeps({
      createConnector: async () => ({
        sync: { errors: [{ slug: 'resend-abc123', error: 'manifest rejected' }] },
      }),
    } as Partial<InstallDeps>);
    expect(await runInstall(deps, { projectId: 'p1', target: mcp(true), connectors: [] })).toEqual({
      status: 'sync_failed',
      name: 'Resend',
      error: 'manifest rejected',
    });
  });

  test('a failure creating the profile rejects, so the caller can show it', async () => {
    const { deps } = fakeDeps({
      createConnector: async () => {
        throw new Error('forbidden');
      },
    });
    await expect(
      runInstall(deps, { projectId: 'p1', target: managed, connectors: [] }),
    ).rejects.toThrow('forbidden');
  });
});
