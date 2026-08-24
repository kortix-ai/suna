import { describe, expect, test } from 'bun:test';

import type { ChangeRequest } from '../api/change-requests';
import { findCachedChangeRequest, type CachedListEntry } from './use-change-requests';

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
