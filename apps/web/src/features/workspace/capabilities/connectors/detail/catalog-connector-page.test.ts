import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const feature = import.meta.dir;
const appRoute = resolve(
  feature,
  '../../../../../app/(app)/projects/[id]/(capabilities)/connectors/catalog/[source]/[slug]/page.tsx',
);

describe('catalogue connector detail route', () => {
  test('resolves every source without loading the catalogue grid', () => {
    const pagePath = join(feature, 'catalog-connector-page.tsx');
    expect(existsSync(appRoute)).toBe(true);
    expect(existsSync(pagePath)).toBe(true);

    const route = readFileSync(appRoute, 'utf8');
    const page = readFileSync(pagePath, 'utf8');

    expect(route).toContain('<CatalogConnectorPage');
    expect(page).toContain('listDiscoverConnectors(projectId, slug)');
    expect(page).toContain('getDiscoverConnector(projectId, discoverEntry.connector.id)');
    expect(page).toContain('listPipedreamApps(projectId, slug)');
    expect(page).toContain('computersCatalogEntry()');
    expect(page).toContain('<ConnectorDetailLayout');
    expect(page).toContain('<ConnectorAdvanced');
    expect(page).toContain('Kortix connector docs');
    expect(page).not.toContain('ConnectorBrowse');
  });

  test('loads add flows only after the primary action is selected', () => {
    const page = readFileSync(join(feature, 'catalog-connector-page.tsx'), 'utf8');
    expect(page).toContain('const DiscoverAddFlow = dynamic(');
    expect(page).toContain('const EasyConnectAddFlow = dynamic(');
    expect(page).toContain('const ComputersAddFlow = dynamic(');
    expect(page).toContain('actionOpen ?');
    expect(page).toContain('connectedConnectorHref(projectId, addedSlug)');
  });
});
