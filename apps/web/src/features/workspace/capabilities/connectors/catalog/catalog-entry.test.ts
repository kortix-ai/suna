import type { AdminConnector, DiscoverConnector, PipedreamApp } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  computersCatalogEntry,
  connectedCatalogKeys,
  isCatalogEntryConnected,
} from './catalog-entry';

const connector = (over: Partial<DiscoverConnector> = {}): DiscoverConnector =>
  ({
    id: 'int_1',
    kind: 'mcp',
    slug: 'linear',
    name: 'Linear',
    description: 'Issue tracking',
    url: null,
    icon: null,
    domain: 'linear.app',
    categories: ['productivity'],
    feeds: [],
    popularity: null,
    ...over,
  }) as DiscoverConnector;

const app = (over: Partial<PipedreamApp> = {}): PipedreamApp => ({
  slug: 'google_sheets',
  name: 'Google Sheets',
  description: 'Spreadsheets',
  imgSrc: null,
  authType: 'oauth',
  categories: ['productivity'],
  hasActions: true,
  hasTriggers: false,
  featuredWeight: 0,
  ...over,
});

const conn = (over: Partial<AdminConnector> = {}): AdminConnector =>
  ({
    slug: 'linear',
    name: 'Linear',
    provider: 'mcp',
    status: 'active',
    credentialMode: 'shared',
    authorizationStrategy: 'project',
    sensitive: false,
    actions: [],
    authSecret: null,
    secretSet: false,
    ...over,
  }) as AdminConnector;

describe('normalising the two catalogues', () => {
  test('Computer Tunnels is a native connector catalogue entry', () => {
    const entry = computersCatalogEntry(testUiTranslator);
    expect(entry).toMatchObject({
      source: 'computer',
      slug: 'computers',
      name: 'Computer Tunnels',
      categories: ['developer-tools'],
    });
  });

  test('a Discover entry keeps its rank and its raw connector', () => {
    const entry = catalogEntryFromDiscover(connector({ popularity: 42 }));
    expect(entry.source).toBe('discover');
    expect(entry.popularity).toBe(42);
    if (entry.source === 'discover') expect(entry.connector.id).toBe('int_1');
  });

  // Pipedream publishes no ranking. `null` keeps these out of the Popular
  // section entirely rather than sorting them to the bottom of it.
  test('an Easy Connect entry is unranked and maps imgSrc to icon', () => {
    const entry = catalogEntryFromEasyConnect(app({ imgSrc: 'https://x/i.png' }));
    expect(entry.source).toBe('easy-connect');
    expect(entry.popularity).toBeNull();
    expect(entry.icon).toBe('https://x/i.png');
  });

  // Both catalogues publish a `slack`. Un-prefixed keys would collide into one
  // React key the moment anything renders them in the same list.
  test('keys are namespaced by source so the two catalogues cannot collide', () => {
    expect(catalogEntryFromDiscover(connector({ id: 'slack', slug: 'slack' })).key).toBe(
      'discover:slack',
    );
    expect(catalogEntryFromEasyConnect(app({ slug: 'slack' })).key).toBe('easy-connect:slack');
  });
});

describe('connected join', () => {
  // The default add flow proposes a connection slug from the app's NAME, so a
  // catalogue slug of `google_sheets` becomes a connector slug of
  // `google-sheets`. Folding both sides is what makes that card show ✓.
  test('matches across slug spellings', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'google-sheets', name: 'Google Sheets' })]);
    expect(isCatalogEntryConnected(catalogEntryFromEasyConnect(app()), keys)).toBe(true);
  });

  test('matches on the connector display name when the slug diverges', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'my-tracker', name: 'Linear' })]);
    expect(isCatalogEntryConnected(catalogEntryFromDiscover(connector()), keys)).toBe(true);
  });

  test('an unrelated connector does not light up a catalogue card', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'stripe', name: 'Stripe' })]);
    expect(isCatalogEntryConnected(catalogEntryFromDiscover(connector()), keys)).toBe(false);
  });

  // The documented ceiling of this join. It must degrade to a redundant `+`,
  // never to a wrong `✓` on some other app.
  test('a fully renamed connector falls back to + rather than matching wrongly', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'tracker', name: 'Tracker' })]);
    expect(isCatalogEntryConnected(catalogEntryFromDiscover(connector()), keys)).toBe(false);
  });

  test('Computer Tunnels stays connected when every profile has a custom name and slug', () => {
    const keys = connectedCatalogKeys([
      conn({ provider: 'computer', slug: 'studio-machines', name: 'Studio' }),
    ]);
    expect(isCatalogEntryConnected(computersCatalogEntry(testUiTranslator), keys)).toBe(true);
  });

  // A connector with a blank name must not index the empty string, or every
  // entry whose name folds to '' would match it.
  test('a nameless connector contributes no empty key', () => {
    expect(connectedCatalogKeys([conn({ slug: 'x', name: '   ' })]).has('')).toBe(false);
  });

  // Prod 2026-08-28: all 6 GitHub connections had a null `connected_account_id`
  // — the OAuth handshake never completed — and zero GitHub tool calls had ever
  // executed. The catalogue still showed GitHub as connected, because a
  // connector ROW existing was treated as proof of a working connection. The
  // user saw a checkmark while every agent call was refused `needs_auth`.
  test('a connector that never completed auth is NOT connected', () => {
    const keys = connectedCatalogKeys([
      conn({ slug: 'github', name: 'GitHub', provider: 'composio', status: 'needs_auth' }),
    ]);
    expect(keys.has('github')).toBe(false);
    expect(keys.has('provider:composio')).toBe(false);
  });

  test('an errored connector still counts as connected — it has a credential', () => {
    const keys = connectedCatalogKeys([
      conn({ slug: 'github', name: 'GitHub', provider: 'composio', status: 'error' }),
    ]);
    expect(keys.has('github')).toBe(true);
  });

  test('one unauthorized connector does not hide a working sibling', () => {
    const keys = connectedCatalogKeys([
      conn({ slug: 'github', name: 'GitHub', provider: 'composio', status: 'needs_auth' }),
      conn({ slug: 'gmail', name: 'Gmail', provider: 'composio', status: 'active' }),
    ]);
    expect(keys.has('github')).toBe(false);
    expect(keys.has('gmail')).toBe(true);
    expect(keys.has('provider:composio')).toBe(true);
  });
});
