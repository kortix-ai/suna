/**
 * The honesty gate for the logged-out connector demo.
 *
 * The list is static because the live catalogue is project-scoped and 401s
 * without a session. Static content drifts into fiction unless something
 * checks it, so these tests check every entry against the repo itself: channel
 * platforms against the executor's `channelLabel()`, connector slugs against
 * the shipped marketplace registry. Inventing an integration fails here.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEMO_CONNECTORS,
  DEMO_CONNECTOR_FILTERS,
  DEMO_CONNECTOR_GROUPS,
  filterDemoConnectors,
  groupDemoConnectors,
} from './demo-connectors';

const REPO_ROOT = new URL('../../../../../../', import.meta.url);

const CHANNELS_SOURCE = readFileSync(
  fileURLToPath(new URL('apps/api/src/executor/channels.ts', REPO_ROOT)),
  'utf8',
);

const REGISTRY = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('packages/starter/templates/marketplace/kortix.registry.json', REPO_ROOT),
    ),
    'utf8',
  ),
) as {
  items: { meta?: { capabilities?: { connectors?: string[] } } }[];
};

const REGISTRY_CONNECTOR_SLUGS = new Set(
  REGISTRY.items.flatMap((item) => item.meta?.capabilities?.connectors ?? []),
);

/** Kortix's own published connector docs — the public claim of what connects. */
const CONNECTOR_DOCS = readFileSync(
  fileURLToPath(new URL('../../../../content/docs/connect/connectors.mdx', import.meta.url)),
  'utf8',
);

/** Comments explain the no-counts rule, so only the code is checked for one. */
const CODE = readFileSync(fileURLToPath(new URL('./demo-connectors.ts', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('every entry is a connector Kortix really supports', () => {
  test('the verification sources are actually loaded', () => {
    // Guards against a moved file silently turning both checks into no-ops.
    expect(CHANNELS_SOURCE).toContain('export function channelLabel');
    expect(REGISTRY_CONNECTOR_SLUGS.size).toBeGreaterThan(10);
  });

  for (const connector of DEMO_CONNECTORS.filter((entry) => entry.kind === 'channel')) {
    test(`${connector.name} is a channel platform the executor knows`, () => {
      expect(CHANNELS_SOURCE).toContain(`case '${connector.slug}':`);
      expect(CHANNELS_SOURCE).toContain(`return '${connector.name}';`);
      // Implemented is not enough for a public demo — the docs must claim it too.
      expect(CONNECTOR_DOCS).toContain(connector.name);
    });
  }

  for (const connector of DEMO_CONNECTORS.filter((entry) => entry.kind === 'app')) {
    test(`${connector.name} is a connector slug the shipped marketplace registry declares`, () => {
      expect(REGISTRY_CONNECTOR_SLUGS.has(connector.slug)).toBe(true);
    });
  }

  test('slugs are unique', () => {
    const slugs = DEMO_CONNECTORS.map((connector) => connector.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('every connector lands in a declared group', () => {
    const groupIds = new Set(DEMO_CONNECTOR_GROUPS.map((group) => group.id));
    for (const connector of DEMO_CONNECTORS) {
      expect(groupIds.has(connector.group)).toBe(true);
    }
  });

  test('every group has something in it, so no header renders empty', () => {
    for (const group of DEMO_CONNECTOR_GROUPS) {
      expect(DEMO_CONNECTORS.some((connector) => connector.group === group.id)).toBe(true);
    }
  });

  test('there are enough to fill the screen', () => {
    expect(DEMO_CONNECTORS.length).toBeGreaterThanOrEqual(12);
  });
});

describe('nothing claims a connection or a count', () => {
  test('no entry describes itself as connected, installed or active', () => {
    for (const connector of DEMO_CONNECTORS) {
      expect(connector.description.toLowerCase()).not.toMatch(
        /\b(connected|installed|active|enabled|your account)\b/,
      );
    }
  });

  test('the data carries no status or count field at all', () => {
    for (const connector of DEMO_CONNECTORS) {
      expect(Object.keys(connector).sort()).toEqual([
        'description',
        'domain',
        'group',
        'kind',
        'name',
        'slug',
      ]);
    }
  });

  test('the module never invents a catalogue size', () => {
    // A catalogue total is not a number this repo can verify, so no copy here
    // may state one.
    expect(CODE).not.toMatch(/\d[\d,]*\s*\+?\s*(apps|integrations|connectors|APIs)/i);
  });

  test('descriptions stay to one line', () => {
    for (const connector of DEMO_CONNECTORS) {
      expect(connector.description.length).toBeLessThanOrEqual(80);
      expect(connector.description).not.toContain('\n');
    }
  });
});

describe('filtering', () => {
  test('returns everything by default', () => {
    expect(filterDemoConnectors('')).toHaveLength(DEMO_CONNECTORS.length);
  });

  test('matches on name, case-insensitively', () => {
    expect(filterDemoConnectors('SLACK').map((c) => c.slug)).toContain('slack');
  });

  test('matches on slug, so google_sheets is findable by its real slug', () => {
    expect(filterDemoConnectors('google_sheets').map((c) => c.slug)).toEqual(['google_sheets']);
  });

  test('matches on description', () => {
    expect(filterDemoConnectors('overdue invoices').map((c) => c.slug)).toEqual(['stripe']);
  });

  test('narrows to one group', () => {
    const communication = filterDemoConnectors('', 'communication');
    expect(communication.length).toBeGreaterThan(0);
    for (const connector of communication) {
      expect(connector.group).toBe('communication');
    }
  });

  test('combines query and group, and can legitimately match nothing', () => {
    expect(filterDemoConnectors('stripe', 'engineering')).toEqual([]);
  });

  test('ignores surrounding whitespace', () => {
    expect(filterDemoConnectors('  linear  ').map((c) => c.slug)).toContain('linear');
  });
});

describe('grouping', () => {
  test('keeps the declared group order', () => {
    const sections = groupDemoConnectors(DEMO_CONNECTORS);
    expect(sections.map((section) => section.group.id)).toEqual(
      DEMO_CONNECTOR_GROUPS.map((group) => group.id),
    );
  });

  test('drops groups a filter emptied', () => {
    const sections = groupDemoConnectors(filterDemoConnectors('stripe'));
    expect(sections).toHaveLength(1);
    expect(sections[0].group.id).toBe('business');
  });

  test('loses nothing', () => {
    const total = groupDemoConnectors(DEMO_CONNECTORS).reduce(
      (sum, section) => sum + section.connectors.length,
      0,
    );
    expect(total).toBe(DEMO_CONNECTORS.length);
  });
});

describe('filter pills', () => {
  test('lead with All, then one pill per group in order', () => {
    expect(DEMO_CONNECTOR_FILTERS.map((option) => option.id)).toEqual([
      'all',
      ...DEMO_CONNECTOR_GROUPS.map((group) => group.id),
    ]);
  });

  test('offer no Connected pill — a signed-out visitor has connected nothing', () => {
    for (const option of DEMO_CONNECTOR_FILTERS) {
      expect(option.label.toLowerCase()).not.toContain('connected');
    }
  });
});
