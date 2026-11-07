import { describe, expect, test } from 'bun:test';
import type { AdminConnector, Connection, DiscoverConnector } from '@kortix/sdk';

import { installOutcome } from './catalog-sheet.tsx';
import {
  accessChoices,
  accountAudience,
  accountFlags,
  connectorMeta,
  connectorWebPath,
  connectorsRows,
  mayChangeAccount,
  resolveConnectTarget,
  wrapText,
} from './connectors-model.ts';

const connector = (overrides: Partial<AdminConnector> = {}): AdminConnector =>
  ({
    slug: 'linear-ab12cd',
    name: 'Linear',
    provider: 'composio',
    status: 'active',
    authSecret: null,
    secretSet: false,
    authorizationStrategy: 'project',
    actions: [{ name: 'list_issues' }, { name: 'create_issue' }],
    ...overrides,
  }) as unknown as AdminConnector;

const account = (overrides: Partial<Connection> = {}): Connection => ({
  connection_id: 'c-1',
  connector_alias: 'linear-ab12cd',
  owner_type: 'member',
  owner_id: 'u-1',
  label: 'Linear',
  status: 'active',
  is_default: false,
  metadata: {},
  authorized: true,
  ...overrides,
});

const app = (overrides: Partial<DiscoverConnector> = {}): DiscoverConnector => ({
  id: 'mcp:deepwiki',
  kind: 'mcp',
  slug: 'deepwiki',
  name: 'DeepWiki',
  description: 'Ask about any public repository.',
  url: null,
  icon: null,
  domain: 'deepwiki.com',
  categories: ['Developer tools'],
  feeds: [],
  popularity: 1,
  oneClick: true,
  ...overrides,
});

describe('connectorsRows', () => {
  test('the project’s connectors come first, by name, each with its listed accounts and state', () => {
    const { project, catalog } = connectorsRows({
      connectors: [connector({ slug: 'slack-x', name: 'Slack' }), connector()],
      connections: [account(), account({ connection_id: 'c-2', connector_alias: 'slack-x', status: 'revoked' })],
      catalog: [app()],
      search: '',
    });
    expect(project.map((row) => [row.name, row.tone, row.accounts.length])).toEqual([
      ['Linear', 'connected', 1],
      // A revoked account is gone: Slack has nothing to run as.
      ['Slack', 'account', 0],
    ]);
    expect(catalog.map((row) => row.id)).toEqual(['a:mcp:deepwiki']);
  });

  test('before the accounts load, a connector is not called "Needs account"', () => {
    const { project } = connectorsRows({ connectors: [connector()], connections: undefined, catalog: [], search: '' });
    expect(project[0]!.tone).toBe('connected');
  });

  test('the search narrows the project’s connectors by name, slug or provider', () => {
    const rows = (search: string) =>
      connectorsRows({ connectors: [connector(), connector({ slug: 'gh', name: 'GitHub', provider: 'mcp' })], connections: [], catalog: [], search })
        .project.map((row) => row.name);
    expect(rows('lin')).toEqual(['Linear']);
    expect(rows('MCP')).toEqual(['GitHub']);
    expect(rows('  ')).toEqual(['GitHub', 'Linear']);
  });

  test('an app the project already has is marked installed', () => {
    const { catalog } = connectorsRows({ connectors: [], connections: [], catalog: [app({ installed: ['deepwiki-1'] })], search: '' });
    expect(catalog[0]!.installed).toBe(true);
  });

  test('the meta line counts accounts and tools and names the provider', () => {
    const { project } = connectorsRows({ connectors: [connector()], connections: [account()], catalog: [], search: '' });
    expect(connectorMeta(project[0]!)).toBe('1 account · 2 tools · Composio');
  });
});

describe('an account row', () => {
  test('says who can use it in the web’s words', () => {
    expect(accountAudience(account(), 'u-1')).toBe('Only you');
    expect(accountAudience(account({ owner_type: 'project', owner_id: null, shared_with: [] }), 'u-1')).toBe('Everyone in workspace');
    const narrowed = account({
      owner_type: 'project',
      owner_id: null,
      shared_with: [
        { grant_id: 'g1', principal_type: 'group', principal_id: 'sales', label: 'Sales', expires_at: null },
        { grant_id: 'g2', principal_type: 'member', principal_id: 'u-9', label: 'ada@example.test', expires_at: null },
      ],
    });
    expect(accountAudience(narrowed, 'u-1')).toBe('Sales +1');
  });

  test('flags what is missing', () => {
    const direct = connector({ provider: 'mcp', authSecret: 'LINEAR_TOKEN' });
    expect(accountFlags(account({ authorized: false }), direct)).toEqual(['Not signed in']);
    expect(accountFlags(account({ metadata: { credential_rejected_at: '2026-11-04' } }), direct)).toEqual([
      'Credential rejected: replace it',
    ]);
    expect(accountFlags(account({ status: 'error' }), direct)).toEqual(['Error']);
    expect(accountFlags(account({ connected_as: 'ada@example.test' }), direct)).toEqual(['Connected as ada@example.test']);
    // A no-auth MCP server (DeepWiki) has nothing to sign in.
    expect(accountFlags(account({ authorized: false }), connector({ provider: 'mcp', authSecret: null }))).toEqual([]);
  });

  test('only its owner, or a connection manager for a shared one, may change it', () => {
    expect(mayChangeAccount(account(), false)).toBe(true);
    expect(mayChangeAccount(account({ owner_type: 'project' }), false)).toBe(false);
    expect(mayChangeAccount(account({ owner_type: 'project' }), true)).toBe(true);
  });
});

describe('accessChoices', () => {
  test('Add account offers the web’s three audiences; sharing an account offers two', () => {
    expect(accessChoices('Acme', 'create').map((choice) => choice.label)).toEqual([
      'Only you',
      'Everyone in Acme',
      'Specific people, groups, or agents',
    ]);
    expect(accessChoices(null, 'share').map((choice) => choice.id)).toEqual(['project', 'members']);
  });
});

describe('resolveConnectTarget', () => {
  const providers = [
    { id: 'openai', label: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic' },
  ];
  test('a query naming one model provider opens /providers on it', () => {
    expect(resolveConnectTarget('OpenAI', providers)).toEqual({ screen: 'providers', target: 'openai' });
    expect(resolveConnectTarget('anthropic', providers)).toEqual({ screen: 'providers', target: 'anthropic' });
  });
  test('anything else searches connectors; nothing opens the chooser', () => {
    expect(resolveConnectTarget(' github ', providers)).toEqual({ screen: 'connectors', target: 'github' });
    expect(resolveConnectTarget('  ', providers)).toBeNull();
  });
});

describe('installOutcome', () => {
  test('a connector to sign in opens Add account; a ready one does not', () => {
    expect(installOutcome({ next: 'connect', name: 'Linear' }, 'Linear')).toEqual({
      message: 'Linear is installed',
      kind: 'info',
      addAccount: true,
    });
    expect(installOutcome({ next: 'ready', name: 'DeepWiki' }, 'DeepWiki').addAccount).toBe(false);
    expect(installOutcome({ next: 'connect', name: 'Linear', existing: true }, 'Linear').message).toBe(
      'Linear is already installed. Opened it.',
    );
    expect(installOutcome({ next: 'fix', name: 'X', error: 'HTTP 500' }, 'X')).toEqual({
      message: 'X is installed. Kortix could not load its tools: HTTP 500',
      kind: 'error',
      addAccount: false,
    });
  });
});

test('connectorWebPath is the web connector page', () => {
  expect(connectorWebPath('p-1', 'linear-ab12cd')).toBe('/workspaces/p-1/admin/connectors/connected/linear-ab12cd');
});

test('wrapText breaks on spaces within the width', () => {
  expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
});

describe('the sheet’s line helpers', () => {
  test('a hint breaks at its separators, never inside an action', async () => {
    const { hintLines } = await import('./connector-sheet.tsx');
    expect(hintLines('a add · s connect · n rename · Esc back', 20)).toEqual(['a add · s connect', 'n rename · Esc back']);
  });
  test('a long link is kept whole, over several lines', async () => {
    const { chunk } = await import('./connector-sheet.tsx');
    expect(chunk('https://example.test/authorize?x=1', 10).join('')).toBe('https://example.test/authorize?x=1');
  });
});
