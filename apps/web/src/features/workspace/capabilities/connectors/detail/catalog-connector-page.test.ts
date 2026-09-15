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

    // The `/connectors/catalog/<source>/<slug>` spelling is retired: the app
    // page is the single-segment `/connectors/<slug>` (non-default catalogues
    // ride as `?src=`), and the old route ONLY forwards there — it must never
    // render the page itself again.
    expect(route).toContain('redirect(');
    expect(route).toContain("params.set('src', 'apps')");
    expect(route).not.toContain('<CatalogConnectorPage');
    expect(page).toContain('listDiscoverConnectors(projectId, slug)');
    expect(page).toContain('getDiscoverConnector(projectId, discoverEntry.connector.id)');
    expect(page).toContain('listPipedreamApps(projectId, slug)');
    expect(page).toContain('computersCatalogEntry(tI18nComplete)');
    expect(page).toContain('<ConnectorDetailLayout');
    // Docs come from the curated per-app map shared with the connected page.
    expect(page).toContain(
      'connectorDocLinks({ provider, slug: entry.slug, name: entry.name }, tI18nComplete)',
    );
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

  test('as a split-view pane, Add REPLACES the connector pane instead of nesting', () => {
    const page = readFileSync(join(feature, 'catalog-connector-page.tsx'), 'utf8');
    const split = readFileSync(join(feature, 'app-connector-split-page.tsx'), 'utf8');
    // The split view hands the page an `addHref` — the app page with `?add=1`
    // (the Install dropdown's own param, honored on mount). Add then
    // NAVIGATES: the connector pane closes and the add column takes its
    // place. Without this, the page nested a second SplitSheet inside the
    // split's left pane and the add column covered the connector pane
    // (Jay, 2026-09-15).
    expect(split).toContain("addHref={`${appHref}${easyConnect ? '&' : '?'}add=1`}");
    expect(page).toContain('addHref ? (');
    expect(page).toContain('<Link href={addHref}>');
    // The `?add=1` mount effect must not reopen the in-place column while the
    // page is a pane — that is the very stacking the prop prevents.
    expect(page).toContain('if (!addHref) {');
  });

  test('the split view never grows a third pane — Connect COVERS the connector pane', () => {
    const split = readFileSync(join(feature, 'app-connector-split-page.tsx'), 'utf8');
    const connected = readFileSync(join(feature, 'connected-connector-page.tsx'), 'utf8');
    // Catalog | connector is the whole row. The connector pane's Connect
    // form takes the pane over instead of opening a nested second column —
    // three surfaces on one row read as overcrowded (Jay, 2026-09-15).
    // Closing the form (its X, Escape) uncovers the connector page.
    expect(split).toContain('connectCoversPage');
    expect(connected).toContain('cover={connectCoversPage}');
    // Standalone connector pages keep the side-by-side Connect column: the
    // prop defaults off.
    expect(connected).toContain('connectCoversPage = false');
  });
});
