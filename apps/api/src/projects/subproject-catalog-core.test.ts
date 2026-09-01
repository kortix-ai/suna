/**
 * `reconcileProjectSubprojectsWithStore` — the pure subproject reconciler.
 *
 * Two failure modes are the whole reason these tests exist, and both lose data
 * silently rather than erroring:
 *   1. Pruning on a read. A GET that observes a stale git checkout must never
 *      be the thing that uninstalls a subproject.
 *   2. Skipping a write that IS a change. The row is what the run report joins
 *      against, so a missed upsert reads as "this subproject did nothing".
 */
import { describe, expect, test } from 'bun:test';
import {
  type ProjectSubprojectCatalogStore,
  type ProjectSubprojectRow,
  reconcileProjectSubprojectsWithStore,
} from './subproject-catalog-core';
import type { SubprojectEntrySpec } from './subprojects';

const PROJECT = 'p1';

function spec(overrides: Partial<SubprojectEntrySpec> = {}): SubprojectEntrySpec {
  return {
    slug: 'seo-watch',
    path: 'kortix.yaml#subprojects.seo-watch',
    repoOwner: 'acme',
    repoName: 'seo-subproject',
    gitRef: 'main',
    resolvedSha: 'abc123',
    version: 'v1.2.0',
    title: 'SEO watch',
    installedAt: '2026-08-30T09:14:02Z',
    owns: { triggers: ['seo-weekly'] },
    ...overrides,
  };
}

/** A store that records every call, so the test can assert writes, not state. */
function fakeStore(initial: ProjectSubprojectRow[] = []) {
  const rows = new Map(initial.map((r) => [r.slug, r]));
  const upserts: string[] = [];
  const removes: string[] = [];
  const store: ProjectSubprojectCatalogStore = {
    async list() {
      return [...rows.values()];
    },
    async upsert(_projectId, s) {
      upserts.push(s.slug);
      rows.set(s.slug, {
        slug: s.slug,
        repoOwner: s.repoOwner,
        repoName: s.repoName,
        gitRef: s.gitRef,
        resolvedSha: s.resolvedSha,
        title: s.title,
        owns: s.owns as Record<string, string[]>,
      });
    },
    async remove(_projectId, slug) {
      removes.push(slug);
      rows.delete(slug);
    },
  };
  return { store, upserts, removes, rows };
}

/** The materialized row that exactly matches `spec()`. */
function matchingRow(overrides: Partial<ProjectSubprojectRow> = {}): ProjectSubprojectRow {
  const s = spec();
  return {
    slug: s.slug,
    repoOwner: s.repoOwner,
    repoName: s.repoName,
    gitRef: s.gitRef,
    resolvedSha: s.resolvedSha,
    title: s.title,
    owns: s.owns as Record<string, string[]>,
    ...overrides,
  };
}

describe('reconcileProjectSubprojectsWithStore', () => {
  test('a newly declared subproject is written', async () => {
    const { store, upserts, removes } = fakeStore();
    const result = await reconcileProjectSubprojectsWithStore(PROJECT, [spec()], store);
    expect(upserts).toEqual(['seo-watch']);
    expect(removes).toEqual([]);
    expect(result).toEqual({ upserted: 1, removed: 0 });
  });

  test('an unchanged subproject is NOT rewritten — updated_at stays meaningful', async () => {
    const { store, upserts } = fakeStore([matchingRow()]);
    const result = await reconcileProjectSubprojectsWithStore(PROJECT, [spec()], store);
    expect(upserts).toEqual([]);
    expect(result.upserted).toBe(0);
  });

  // Each of these is a real edit that must reach the row. A missed one leaves
  // the projection lying about what is installed.
  const changes: Array<[string, Partial<SubprojectEntrySpec>]> = [
    ['a moved sha (the subproject was updated)', { resolvedSha: 'def456' }],
    ['a different branch/tag', { gitRef: 'v2' }],
    ['a renamed repo', { repoName: 'seo-subproject-2' }],
    ['a new owner', { repoOwner: 'other' }],
    ['a retitled subproject', { title: 'SEO watchdog' }],
    ['a subproject that gained a trigger', { owns: { triggers: ['seo-weekly', 'seo-daily'] } }],
    ['a subproject that lost everything it owned', { owns: {} }],
  ];
  for (const [label, overrides] of changes) {
    test(`${label} is written`, async () => {
      const { store, upserts } = fakeStore([matchingRow()]);
      await reconcileProjectSubprojectsWithStore(PROJECT, [spec(overrides)], store);
      expect(upserts).toEqual(['seo-watch']);
    });
  }

  test('owns comparison ignores key order and list order', async () => {
    const { store, upserts } = fakeStore([
      matchingRow({ owns: { triggers: ['b', 'a'], agents: ['x'] } }),
    ]);
    await reconcileProjectSubprojectsWithStore(
      PROJECT,
      [spec({ owns: { agents: ['x'], triggers: ['a', 'b'] } })],
      store,
    );
    expect(upserts).toEqual([]);
  });

  test('an empty owns list equals an absent one', async () => {
    const { store, upserts } = fakeStore([matchingRow({ owns: { triggers: [] } })]);
    await reconcileProjectSubprojectsWithStore(PROJECT, [spec({ owns: {} })], store);
    expect(upserts).toEqual([]);
  });

  test('a subproject the manifest no longer declares is removed', async () => {
    const { store, removes, rows } = fakeStore([
      matchingRow(),
      matchingRow({ slug: 'gone', repoName: 'old' }),
    ]);
    const result = await reconcileProjectSubprojectsWithStore(PROJECT, [spec()], store);
    expect(removes).toEqual(['gone']);
    expect(result.removed).toBe(1);
    expect(rows.has('seo-watch')).toBe(true);
  });

  test('pruneStale:false never removes — a stale READ cannot uninstall a subproject', async () => {
    const { store, removes, rows } = fakeStore([
      matchingRow(),
      matchingRow({ slug: 'not-in-this-checkout', repoName: 'other' }),
    ]);
    const result = await reconcileProjectSubprojectsWithStore(PROJECT, [spec()], store, {
      pruneStale: false,
    });
    expect(removes).toEqual([]);
    expect(result.removed).toBe(0);
    expect(rows.has('not-in-this-checkout')).toBe(true);
  });

  test('an empty manifest section with pruning removes every row', async () => {
    const { store, removes } = fakeStore([matchingRow(), matchingRow({ slug: 'b' })]);
    const result = await reconcileProjectSubprojectsWithStore(PROJECT, [], store);
    expect(removes.sort()).toEqual(['b', 'seo-watch']);
    expect(result).toEqual({ upserted: 0, removed: 2 });
  });

  test('a legacy row with null columns converges instead of being seen as equal', async () => {
    const { store, upserts } = fakeStore([
      { slug: 'seo-watch', repoOwner: null, repoName: null, gitRef: null, title: null, owns: null },
    ]);
    await reconcileProjectSubprojectsWithStore(PROJECT, [spec()], store);
    expect(upserts).toEqual(['seo-watch']);
  });
});
