import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dir, 'connectors-page.tsx'), 'utf8');
const browse = readFileSync(join(import.meta.dir, 'catalog/connector-browse.tsx'), 'utf8');
const card = readFileSync(join(import.meta.dir, '../shared/catalog/catalog-card.tsx'), 'utf8');

describe('connector card routes', () => {
  test('connected cards link to the connected connector route', () => {
    expect(page).toContain('href={connectedConnectorHref(projectId, connector.slug)}');
    expect(page).not.toContain("params.set('c'");
    expect(page).not.toContain('<ConnectorModal');
    // Legacy `?c=<slug>` (modal-era bookmarks, and OAuth 2.0 returns whose
    // redirect URI was minted before the detail became a route) must forward
    // to the connector's page instead of dying silently on the list.
    expect(page).toContain("search?.get('c')");
    expect(page).toContain('connectedConnectorHref(projectId, legacyDetailSlug)');
    // The catalogue-source toggle ("MCP & APIs" / "OAuth apps") was removed by
    // Jay — one catalogue, no switch. Keep it out.
    expect(page).not.toContain('TabsListCompact');
    expect(page).not.toContain('OAuth apps');
  });

  test('catalogue cards link to the source-specific catalogue route', () => {
    expect(page).toContain('catalogConnectorHref(projectId, entry)');
    expect(browse).toContain('href={getHref(entry)}');
    expect(browse).not.toContain('onSelect: (entry: CatalogEntry) => void');
  });

  test('CatalogCard renders a prefetchable Next link when href is present', () => {
    expect(card).toContain('href?: string');
    expect(card).toContain('if (href) {');
    expect(card).toContain('<Link');
    // Without `prefetch` the card is a link that still costs a cold navigation.
    expect(card).toContain('prefetch');
  });
});
