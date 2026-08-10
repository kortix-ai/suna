import { beforeEach, describe, expect, test } from 'bun:test';

import {
  CATALOG_TTL_MS,
  buildSnapshot,
  crawlCatalog,
  ensureCatalogSnapshot,
  getCatalogSnapshot,
  resetCatalogSnapshot,
  type CatalogPageFetcher,
} from './pipedream-index';
import type { CatalogApp } from './pipedream-search';

function app(overrides: Partial<CatalogApp> & { slug: string; name: string }): CatalogApp {
  return {
    description: null,
    imgSrc: null,
    authType: 'keys',
    categories: [],
    hasActions: true,
    hasTriggers: false,
    featuredWeight: 0,
    ...overrides,
  };
}

/** A fetcher over a fixed list, paged the way Pipedream pages: an opaque
 *  cursor, absent on the last page. Counts its own calls. */
function pagedFetcher(apps: CatalogApp[], pageSize = 100) {
  const calls: Array<string | undefined> = [];
  const fetchPage: CatalogPageFetcher = async (_limit, cursor) => {
    calls.push(cursor);
    const offset = cursor ? Number(cursor) : 0;
    const slice = apps.slice(offset, offset + pageSize);
    const end = offset + pageSize;
    return { apps: slice, ...(end < apps.length ? { nextCursor: String(end) } : {}) };
  };
  return { fetchPage, calls };
}

beforeEach(() => resetCatalogSnapshot());

describe('crawlCatalog', () => {
  test('walks every page and keeps the order it built', async () => {
    const apps = Array.from({ length: 250 }, (_, i) =>
      app({ slug: `a${i}`, name: `App ${String(i).padStart(3, '0')}` }),
    );
    const { fetchPage, calls } = pagedFetcher(apps);

    const snapshot = await crawlCatalog(fetchPage, () => 1_000);

    expect(snapshot.apps).toHaveLength(250);
    expect(calls).toEqual([undefined, '100', '200']);
    expect(snapshot.fetchedAt).toBe(1_000);
  });

  test('keeps every record — no app is withheld from the catalogue', async () => {
    const { fetchPage } = pagedFetcher([
      app({ slug: 'github', name: 'GitHub' }),
      app({ slug: 'oracle_cloud_infrastructure', name: 'Oracle Cloud Infrastructure' }),
      // Was dropped by UTILITY_APP_SLUGS.
      app({ slug: 'schedule', name: 'Schedule', hasActions: false }),
      // Were dropped by NATIVE_APP_SLUGS. This is the `q=slack` bug: Pipedream
      // reports 11 matches, Kortix reported 10, and these two were the gap.
      // The set never covered `slack_v2` — the record that IS the main Slack —
      // so it hid the legacy pair while achieving nothing it claimed to.
      app({ slug: 'slack', name: 'Slack (legacy)' }),
      app({ slug: 'slack_bot', name: 'Bot for Slack' }),
      app({ slug: 'slack_v2', name: 'Slack' }),
      // Were dropped by `hasActions`. 1,263 apps, none reachable by any query,
      // including their own exact name.
      app({ slug: 'sap_s_4hana_cloud', name: 'SAP S/4HANA Cloud', hasActions: false }),
      app({ slug: 'triggers_only', name: 'Triggers Only', hasActions: false, hasTriggers: true }),
    ]);

    const snapshot = await crawlCatalog(fetchPage, () => 0);

    // Connectable apps first, then the action-less ones. Every record present.
    expect(snapshot.apps.map((a) => a.slug)).toEqual([
      'slack_bot',
      'github',
      'oracle_cloud_infrastructure',
      // "Slack" before "Slack (legacy)" — same weight, both connectable, so
      // `localeCompare` decides and the shorter name is the prefix.
      'slack_v2',
      'slack',
      'sap_s_4hana_cloud',
      'schedule',
      'triggers_only',
    ]);
  });

  test('action-less apps join their category, counted and ranked last', async () => {
    const { fetchPage } = pagedFetcher([
      app({ slug: 'real', name: 'Real', categories: ['CRM'] }),
      app({ slug: 'hollow', name: 'Hollow', categories: ['CRM'], hasActions: false }),
    ]);

    const snapshot = await crawlCatalog(fetchPage, () => 0);

    // The facet count drives a section heading, and the heading now states the
    // category's real size because the grid can show every one of them.
    expect(snapshot.categories).toEqual([{ key: 'CRM', label: 'CRM', count: 2 }]);
    expect(snapshot.byCategory.get('CRM')?.map((a) => a.slug)).toEqual(['real', 'hollow']);
  });

  test('stops on a repeating cursor instead of looping forever', async () => {
    let calls = 0;
    const fetchPage: CatalogPageFetcher = async () => {
      calls++;
      return { apps: [app({ slug: `a${calls}`, name: 'A' })], nextCursor: 'stuck' };
    };

    const snapshot = await crawlCatalog(fetchPage, () => 0);

    expect(calls).toBe(2);
    expect(snapshot.apps).toHaveLength(2);
  });

  test('stops on an empty page even when a cursor is offered', async () => {
    let calls = 0;
    const fetchPage: CatalogPageFetcher = async () => {
      calls++;
      return { apps: [], nextCursor: `page-${calls}` };
    };

    await crawlCatalog(fetchPage, () => 0);

    expect(calls).toBe(1);
  });
});

describe('buildSnapshot', () => {
  test('buckets by category with true counts, largest first', () => {
    const snapshot = buildSnapshot(
      [
        app({ slug: 'a', name: 'A', categories: ['Marketing', 'CRM'] }),
        app({ slug: 'b', name: 'B', categories: ['Marketing'] }),
        app({ slug: 'c', name: 'C', categories: ['CRM'] }),
        app({ slug: 'd', name: 'D', categories: ['Marketing'] }),
      ],
      0,
    );

    expect(snapshot.categories).toEqual([
      { key: 'Marketing', label: 'Marketing', count: 3 },
      { key: 'CRM', label: 'CRM', count: 2 },
    ]);
    expect(snapshot.byCategory.get('CRM')?.map((a) => a.slug)).toEqual(['a', 'c']);
  });

  test('ranks each bucket by prominence, not crawl order', () => {
    const snapshot = buildSnapshot(
      [
        app({ slug: 'plain', name: 'Plain', categories: ['CRM'] }),
        app({ slug: 'promoted', name: 'Zebra', categories: ['CRM'], featuredWeight: 9 }),
      ],
      0,
    );

    expect(snapshot.byCategory.get('CRM')?.map((a) => a.slug)).toEqual(['promoted', 'plain']);
  });

  test('ignores blank category strings rather than making a blank section', () => {
    // `Malwarebytes` ships `categories: ['']` in the live catalogue.
    const snapshot = buildSnapshot([app({ slug: 'm', name: 'M', categories: ['', ' '] })], 0);

    expect(snapshot.categories).toEqual([]);
    expect(snapshot.apps).toHaveLength(1);
  });
});

describe('getCatalogSnapshot', () => {
  test('first call returns nothing, reports warming, and starts one crawl', async () => {
    const { fetchPage, calls } = pagedFetcher([app({ slug: 'a', name: 'A' })]);

    const first = getCatalogSnapshot(fetchPage, () => 0);

    expect(first.snapshot).toBeNull();
    expect(first.warming).toBe(true);
    await ensureCatalogSnapshot(fetchPage, () => 0);
    expect(calls).toHaveLength(1);
  });

  test('serves the snapshot once the crawl lands', async () => {
    const { fetchPage } = pagedFetcher([app({ slug: 'a', name: 'A' })]);

    getCatalogSnapshot(fetchPage, () => 0);
    await ensureCatalogSnapshot(fetchPage, () => 0);

    const warm = getCatalogSnapshot(fetchPage, () => 0);
    expect(warm.warming).toBe(false);
    expect(warm.snapshot?.apps.map((a) => a.slug)).toEqual(['a']);
  });

  test('single-flight: concurrent cold callers share one crawl', async () => {
    let calls = 0;
    const fetchPage: CatalogPageFetcher = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { apps: [app({ slug: 'a', name: 'A' })] };
    };

    getCatalogSnapshot(fetchPage, () => 0);
    getCatalogSnapshot(fetchPage, () => 0);
    getCatalogSnapshot(fetchPage, () => 0);
    await ensureCatalogSnapshot(fetchPage, () => 0);

    expect(calls).toBe(1);
  });

  test('serves a stale snapshot while refreshing behind it', async () => {
    const first = pagedFetcher([app({ slug: 'old', name: 'Old' })]);
    getCatalogSnapshot(first.fetchPage, () => 0);
    await ensureCatalogSnapshot(first.fetchPage, () => 0);

    const second = pagedFetcher([app({ slug: 'new', name: 'New' })]);
    const later = CATALOG_TTL_MS + 1;

    // The stale copy is returned immediately — the caller does not wait.
    const during = getCatalogSnapshot(second.fetchPage, () => later);
    expect(during.warming).toBe(false);
    expect(during.snapshot?.apps.map((a) => a.slug)).toEqual(['old']);

    await ensureCatalogSnapshot(second.fetchPage, () => later);
    expect(getCatalogSnapshot(second.fetchPage, () => later).snapshot?.apps.map((a) => a.slug)).toEqual(
      ['new'],
    );
  });

  test('does not refresh inside the TTL', async () => {
    const { fetchPage, calls } = pagedFetcher([app({ slug: 'a', name: 'A' })]);
    getCatalogSnapshot(fetchPage, () => 0);
    await ensureCatalogSnapshot(fetchPage, () => 0);

    getCatalogSnapshot(fetchPage, () => CATALOG_TTL_MS - 1);
    getCatalogSnapshot(fetchPage, () => CATALOG_TTL_MS - 1);

    expect(calls).toHaveLength(1);
  });

  test('a failed crawl leaves the cache empty and the next call retries', async () => {
    let calls = 0;
    const fetchPage: CatalogPageFetcher = async () => {
      calls++;
      if (calls === 1) throw new Error('pipedream down');
      return { apps: [app({ slug: 'a', name: 'A' })] };
    };

    getCatalogSnapshot(fetchPage, () => 0);
    await ensureCatalogSnapshot(fetchPage, () => 0).catch(() => {});
    expect(getCatalogSnapshot(fetchPage, () => 0).snapshot).toBeNull();

    await ensureCatalogSnapshot(fetchPage, () => 0);
    expect(getCatalogSnapshot(fetchPage, () => 0).snapshot?.apps).toHaveLength(1);
  });
});
