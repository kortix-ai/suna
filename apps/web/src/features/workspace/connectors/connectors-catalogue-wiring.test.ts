/**
 * Source-text contract for the connectors LIST.
 *
 * The rail is gone. Every entry point it used to own has to exist somewhere
 * else, and the `?c=` deep links it produced have to keep working — those are
 * the two things a future refactor is most likely to quietly drop, so they are
 * asserted here rather than left to a manual click-through.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_SRC = join(import.meta.dir, '..', '..', '..');

const VIEW = readFileSync(
  join(WEB_SRC, 'features/workspace/customize/sections/connectors-view.tsx'),
  'utf8',
);
const CATALOGUE = readFileSync(join(import.meta.dir, 'connectors-catalogue.tsx'), 'utf8');
const ROUTE = readFileSync(join(WEB_SRC, 'app/(app)/projects/[id]/connectors/page.tsx'), 'utf8');

describe('the rail is gone', () => {
  test('no rail component survives in connectors-view', () => {
    expect(VIEW).not.toContain('function ConnectorRail');
    expect(VIEW).not.toContain('function RailItem');
    expect(VIEW).not.toContain('function RailGroupLabel');
    expect(VIEW).not.toContain('<ConnectorRail');
  });

  test('and neither does its 288px column', () => {
    expect(VIEW).not.toContain('flex w-72 shrink-0 flex-col border-r');
  });
});

describe('everything the rail reached still has a home', () => {
  test('its search became the page search', () => {
    expect(CATALOGUE).toContain("placeholder: 'Search all connectors'");
  });

  test('its "Add app" button became the primary action', () => {
    expect(CATALOGUE).toContain("onSelect('add')");
    expect(CATALOGUE).toContain('Add connector');
  });

  test('Global rules and Sync from repo moved to the overflow menu', () => {
    expect(CATALOGUE).toContain("onSelect('global')");
    expect(CATALOGUE).toContain('Global rules');
    expect(CATALOGUE).toContain('Sync from repo');
    expect(CATALOGUE).toContain('syncConnectors');
  });

  test('its connector list became the grid', () => {
    expect(CATALOGUE).toContain('<ConnectorCatalogueGroups');
    expect(CATALOGUE).toContain('<ConnectorCatalogueGrid');
  });
});

describe('?c= deep links still open the panes they always did', () => {
  test('the catalogue is what you get with no ?c=', () => {
    expect(VIEW).toContain("const rawC = search?.get('c') ?? '';");
    expect(VIEW).toContain('if (!rawC) {');
    expect(VIEW).toContain('<ConnectorsCatalogue');
  });

  test('add, global and a slug all still resolve', () => {
    expect(VIEW).toContain("if (rawC === 'global') return { kind: 'global' };");
    expect(VIEW).toContain('if (rawC && connectors.some((c) => c.slug === rawC))');
    expect(VIEW).toContain('<AddAppPanel');
    expect(VIEW).toContain('<GlobalRulesPanel');
    expect(VIEW).toContain('<ConnectorDetail');
  });

  test('the detail pane offers a way back to the list', () => {
    expect(VIEW).toContain('onBack');
    expect(VIEW).toContain('<ChevronLeft className="size-4" />');
  });

  test('removing a connector returns to the list, not to Add', () => {
    expect(VIEW).toContain(
      'onRemoved={() => {\n              invalidate();\n              onBack();',
    );
  });
});

describe('the catalogue uses the shared shell', () => {
  test('title, one-line description and the four filter pills', () => {
    expect(CATALOGUE).toContain('<ProjectSectionPage');
    expect(CATALOGUE).toContain('title="Connectors"');
    expect(CATALOGUE).toContain('CATALOGUE_PILLS.map');
  });

  test('the description fits the shell contract', () => {
    const match = CATALOGUE.match(/description="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match?.[1]?.length ?? 999).toBeLessThanOrEqual(90);
  });

  test('grouping is dropped once a search or category narrows the list', () => {
    expect(CATALOGUE).toContain(
      "const grouped = pill === 'discover' && !query.trim() && !activeCategory;",
    );
  });

  test('the category picker is built from loaded entries, not invented', () => {
    expect(CATALOGUE).toContain('catalogueCategories(entries)');
    expect(CATALOGUE).toContain('All categories');
  });

  test('read-only members get no add affordance', () => {
    expect(CATALOGUE).toContain('canWrite ? (entry) => addApp.mutate(entry) : undefined');
  });

  test('Slack stays out of the catalogue because it is a built-in channel', () => {
    expect(CATALOGUE).toContain("new Set(['slack', 'slack_v2'])");
  });
});

describe('the route', () => {
  test('the retired route redirects into the one Customize surface', () => {
    // Connectors is a section of Customize again, not a top-level page. The
    // URL stays valid because it shipped and is linked from the palette.
    expect(ROUTE).toContain('redirect(');
    expect(ROUTE).toContain('customize/connectors');
  });
});
