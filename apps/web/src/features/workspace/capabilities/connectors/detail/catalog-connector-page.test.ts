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
    expect(page).toContain('computersCatalogEntry(tI18nComplete)');
    expect(page).toContain('<ConnectorDetailLayout');
    // Docs come from the curated per-app map shared with the connected page.
    expect(page).toContain('connectorDocLinks({ provider, slug: entry.slug, name: entry.name })');
    expect(page).not.toContain('ConnectorBrowse');
  });

  test('discover adds through the SPLIT column; modal flows stay prop-driven', () => {
    const page = readFileSync(join(feature, 'catalog-connector-page.tsx'), 'utf8');
    // Discover entries add through an inline SplitSheet column — the page
    // narrows, nothing overlays it. Other sources keep their modal flows.
    expect(page).toContain('const DiscoverAddSheet = dynamic(');
    expect(page).toContain('<SplitSheet');
    expect(page).toContain("open={entry.source === 'discover' && actionOpen}");
    expect(page).toContain('<SplitSheetMain');
    expect(page).toContain('<SplitSheetTrigger asChild>');
    expect(page).toContain('const EasyConnectAddFlow = dynamic(');
    expect(page).toContain('const ComputersAddFlow = dynamic(');
    // Modal flows are multi-step with internal state; gating their MOUNT on
    // `actionOpen` destroys it mid-hand-off ("Add connector does nothing").
    // Open must be a PROP:
    expect(page).toContain('app={actionOpen ? entry.app : null}');
    expect(page).toContain('open={actionOpen}');
    expect(page).not.toContain('{actionOpen ? (');
    expect(page).toContain('connectedConnectorHref(projectId, addedSlug)');
  });
});
