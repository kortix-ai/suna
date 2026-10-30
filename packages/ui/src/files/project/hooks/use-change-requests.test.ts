import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';

import type { ChangeRequest } from '../api/change-requests';
import {
  changeRequestKeys,
  findCachedChangeRequest,
  invalidateAfterChangeRequestWrite,
  invalidateChangeRequestReads,
  type CachedListEntry,
} from './use-change-requests';

/**
 * Opening a proposed change used to cost two SERIAL round trips before its
 * merge button worked:
 *
 *   1. `GET /change-requests/:id` — whose entire body is `{ change_request }`,
 *      i.e. the very object the list response already held.
 *   2. `GET .../merge-preview` — which could not even START until (1) landed,
 *      because the dialog gates it on `status === 'open'`.
 *
 * Seeding the detail cache from the list collapses both: the header paints on
 * the click frame and the preview fires in parallel. These tests pin the
 * lookup that makes that possible.
 */
function cr(id: string, extra: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    cr_id: id,
    number: 1,
    title: `CR ${id}`,
    status: 'open',
    base_ref: 'main',
    head_ref: 'feat',
    created_at: new Date().toISOString(),
    ...extra,
  } as ChangeRequest;
}

const entry = (key: readonly unknown[], rows: ChangeRequest[] | undefined): CachedListEntry => [
  key,
  rows ? { change_requests: rows } : undefined,
];

describe('findCachedChangeRequest', () => {
  test('finds a change request in the only cached bucket', () => {
    const target = cr('a');
    const hit = findCachedChangeRequest([entry(['list', 'open'], [cr('z'), target])], 'a');
    expect(hit?.cr).toBe(target);
  });

  /**
   * The panel's filter decides which bucket is populated, and "All" overlaps
   * every other one — so the scan cannot assume a single list.
   */
  test('searches every status bucket, not just the first', () => {
    const target = cr('b', { status: 'merged' });
    const hit = findCachedChangeRequest(
      [
        entry(['list', 'open'], [cr('x')]),
        entry(['list', 'closed'], []),
        entry(['list', 'merged'], [target]),
      ],
      'b',
    );
    expect(hit?.cr).toBe(target);
  });

  /**
   * The caller reads `dataUpdatedAt` off the returned key to date the seed.
   * Reporting the wrong list would stamp it with another bucket's fetch time,
   * which decides whether the background refetch fires.
   */
  test('reports which bucket the row came from', () => {
    const hit = findCachedChangeRequest(
      [entry(['list', 'open'], [cr('x')]), entry(['list', 'all'], [cr('c')])],
      'c',
    );
    expect(hit?.key).toEqual(['list', 'all']);
  });

  /**
   * The Changes panel's `useInfiniteQuery` entry sits under the same list
   * scope as `{ pages, pageParams }`. A scan that read only
   * `data.change_requests` threw on it during render (KRTX-2316).
   */
  test('reads the paged panel entry and scans past it', () => {
    const paged = cr('p', { status: 'merged' });
    const target = cr('t', { status: 'closed' });
    const entries: CachedListEntry[] = [
      [
        ['list', 'merged', 'pages'],
        {
          pages: [{ change_requests: [cr('x')] }, { change_requests: [paged] }],
          pageParams: [undefined, 'c1'],
        },
      ],
      entry(['list', 'closed'], [target]),
    ];
    expect(findCachedChangeRequest(entries, 't')).toEqual({ cr: target, key: ['list', 'closed'] });
    expect(findCachedChangeRequest(entries, 'p')).toEqual({
      cr: paged,
      key: ['list', 'merged', 'pages'],
    });
  });

  test('tolerates a cache entry that has no data yet', () => {
    expect(findCachedChangeRequest([entry(['list', 'open'], undefined)], 'a')).toBeUndefined();
  });

  test('returns undefined when nothing is cached', () => {
    expect(findCachedChangeRequest([], 'a')).toBeUndefined();
  });

  test('does not match a different change request', () => {
    expect(findCachedChangeRequest([entry(['list', 'open'], [cr('a')])], 'b')).toBeUndefined();
  });

  test('an empty id never matches', () => {
    expect(findCachedChangeRequest([entry(['list', 'open'], [cr('')])], '')).toBeUndefined();
  });
});

/**
 * The count badge and both command palette reads share the `list(…, 'open')`
 * entry. One reader without the 100-row limit got the server's 50-row page and
 * wrote it over the others, so the badge dropped from 73 to 50 (KRTX-2316).
 */
describe("the shared 'open' change-request entry", () => {
  test('every reader builds it with openChangeRequestListQuery', () => {
    const src = join(import.meta.dir, '../../..');
    const owners: string[] = [];
    for (const file of new Glob('**/*.{ts,tsx}').scanSync(src)) {
      if (file.includes('.test.')) continue;
      const hits = readFileSync(join(src, file), 'utf8').match(
        /changeRequestKeys\.list\([^)]*'open'\)/g,
      );
      for (const _ of hits ?? []) owners.push(file);
    }
    expect(owners).toEqual(['files/project/hooks/use-change-requests.ts']);
  });
});

/**
 * KRTX-3012: applying a change request that rewrote kortix.yaml left New
 * session offering the removed agents, with the removed default still
 * selected, until a reload. The project detail entry holds both the agent list
 * (`[...detail, 'agents']`) and `default_agent`, and nothing invalidated it.
 */
describe('invalidateAfterChangeRequestWrite', () => {
  test('marks the project detail and its agent list stale, and leaves other projects alone', () => {
    const qc = new QueryClient();
    const detail = qk.project.detail('p1');
    const agents = [...detail, 'agents'];
    const otherDetail = qk.project.detail('p2');
    qc.setQueryData(detail, { default_agent: 'company-operator' });
    qc.setQueryData(agents, [{ name: 'company-operator' }]);
    qc.setQueryData(otherDetail, { default_agent: 'kortix' });

    invalidateAfterChangeRequestWrite(qc, 'p1');

    expect(qc.getQueryState(detail)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(agents)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(otherDetail)?.isInvalidated).toBe(false);
  });
});

/**
 * KRTX-3009 / KRTX-3010: an agent opens and closes change requests from its
 * sandbox through the REST API, and the browser hears nothing. At turn end the
 * session's list still held the closed #2 and not the new #3, so Review opened
 * #2, or showed nothing for a new one, and the sidebar kept #2 as pending.
 * The turn-end refresh marks every change-request read of the project stale,
 * plus the review summary the sidebar's "Needs you" counts read.
 */
describe('invalidateChangeRequestReads', () => {
  test('marks the session list, the sidebar list and the review summary stale', () => {
    const qc = new QueryClient();
    const session = changeRequestKeys.sessionList('p1', 's1');
    const recent = [...changeRequestKeys.listScope('p1'), 'recent'];
    const summary = qk.project.reviewSummary('p1');
    const otherSession = changeRequestKeys.sessionList('p2', 's9');
    for (const key of [session, recent, summary, otherSession]) qc.setQueryData(key, { seeded: true });

    invalidateChangeRequestReads(qc, 'p1');

    expect(qc.getQueryState(session)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(recent)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(summary)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(otherSession)?.isInvalidated).toBe(false);
  });

  test('an empty project id touches nothing', () => {
    const qc = new QueryClient();
    const summary = qk.project.reviewSummary('p1');
    qc.setQueryData(summary, { seeded: true });
    invalidateChangeRequestReads(qc, '');
    expect(qc.getQueryState(summary)?.isInvalidated).toBe(false);
  });

  // KRTX-3019: a merge or close in the dialog left the sidebar on "Needs you".
  test('a change-request write also refreshes the review summary', () => {
    const qc = new QueryClient();
    const summary = qk.project.reviewSummary('p1');
    qc.setQueryData(summary, { seeded: true });
    invalidateAfterChangeRequestWrite(qc, 'p1');
    expect(qc.getQueryState(summary)?.isInvalidated).toBe(true);
  });
});
