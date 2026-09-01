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
  });

  test('catalogue cards link to the source-specific catalogue route', () => {
    expect(page).toContain('catalogConnectorHref(projectId, entry)');
    expect(browse).toContain('href={getHref(entry)}');
    expect(browse).not.toContain('onSelect: (entry: CatalogEntry) => void');
  });

  test('CatalogCard renders a prefetchable Next link when href is present', () => {
    expect(card).toContain('href?: string');
    expect(card).toContain('return href ?');
    expect(card).toContain('<Link');
  });
});
