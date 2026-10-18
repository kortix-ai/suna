import { testUiTranslator } from '@/i18n/test-translator';
import type { AdminConnector } from '@kortix/sdk';
import { expect, test } from 'bun:test';

import {
  catalogEntryFromProject,
  isCatalogEntryConnected,
  type CatalogEntry,
} from './catalog-entry';
import { assembleCatalogEntries } from './use-catalog';

// KRTX-2531: the All tab rendered only the remote catalogue. A connector the
// project already declares in kortix.yaml — a hand-declared MCP URL, a channel
// row — appears in NEITHER catalogue, so the All tab simply did not show it,
// and a search that matched it showed nothing. The project's own connectors
// lead the grid (deduped against the catalogue by the same lenient join the
// "Added" badge uses), so the tab lists everything the project can call.

function projectConnector(slug: string, name?: string): AdminConnector {
  return {
    slug,
    name: name ?? slug,
    provider: 'mcp',
    status: 'active',
    credentialMode: 'shared',
    authorizationStrategy: 'project',
    sensitive: false,
    actions: [],
    authSecret: null,
    secretSet: true,
  };
}

function catalogEntry(slug: string, name?: string): CatalogEntry {
  return {
    source: 'discover',
    key: `discover:${slug}`,
    slug,
    name: name ?? slug,
    description: null,
    icon: null,
    categories: [],
    popularity: null,
    connector: {
      id: slug,
      slug,
      name: name ?? slug,
      kind: 'api',
      categories: [],
      popularity: null,
      description: null,
      icon: null,
      baseUrl: null,
      auth: null,
      headers: null,
      actions: [],
    } as never,
  };
}

function assemble(extra: Partial<Parameters<typeof assembleCatalogEntries>[0]>) {
  return assembleCatalogEntries({
    source: 'discover',
    computers: false,
    activeQuery: '',
    searchDirect: false,
    tI18nComplete: testUiTranslator,
    ...extra,
  });
}

test('a project connector the catalogue does not list gets its own leading card', () => {
  const entries = assemble({
    discoverPages: [
      { items: [catalogEntry('github')], total: 1, nextCursor: null, hasMore: false },
    ] as never,
    projectConnectors: [projectConnector('dogfood-mcp', 'Dogfood MCP')],
  });
  expect(entries[0]!.source).toBe('project');
  expect(entries[0]!.slug).toBe('dogfood-mcp');
  expect(entries.map((e) => e.slug)).toContain('github');
});

test('a project connector the catalogue lists does not duplicate the card', () => {
  const entries = assemble({
    discoverPages: [
      { items: [catalogEntry('github', 'GitHub')], total: 1, nextCursor: null, hasMore: false },
    ] as never,
    projectConnectors: [projectConnector('github')],
  });
  expect(entries.filter((e) => e.slug === 'github')).toHaveLength(1);
  expect(entries[0]!.source).toBe('discover');
});

test('computer rows add no card — the native Computers card covers them', () => {
  const entries = assemble({
    projectConnectors: [
      { ...projectConnector('computer'), provider: 'computer' as const },
      projectConnector('dogfood-mcp'),
    ],
  });
  expect(entries.filter((e) => e.source === 'computer')).toHaveLength(0);
  expect(entries.filter((e) => e.source === 'project')).toHaveLength(1);
});

test('a search filters the project cards by name or slug', () => {
  const entries = assemble({
    activeQuery: 'dogfood',
    projectConnectors: [projectConnector('dogfood-mcp'), projectConnector('other-svc')],
  });
  expect(entries.map((e) => e.slug)).toEqual(['dogfood-mcp']);
});

test('a project entry is its own connected fact and labels itself by provider', () => {
  const entry = catalogEntryFromProject(projectConnector('dogfood-mcp', 'Dogfood MCP'));
  expect(entry.source).toBe('project');
  expect(isCatalogEntryConnected(entry, new Set())).toBe(true);
  expect(entry.name).toBe('Dogfood MCP');
});
