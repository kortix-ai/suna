import { describe, expect, test } from 'bun:test';

import { changeRequestToReviewItem } from './review-adapters';
import {
  changeRequestStatusesForSegment,
  collectInboxItems,
  decodeInboxCursor,
  encodeInboxCursor,
  type InboxSources,
  statusesForSegment,
} from './review-items';

// review_items row factory (only the fields serializeReviewItem touches).
function nativeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    reviewItemId: 'ri_1',
    accountId: 'acc_1',
    projectId: 'proj_1',
    originSessionId: null,
    kind: 'output',
    status: 'needs_you',
    risk: 'none',
    source: 'agent',
    title: 'Native item',
    summary: '',
    detail: {},
    agent: '',
    createdBy: 'user_1',
    actedBy: null,
    actedAt: null,
    feedback: null,
    metadata: {},
    createdAt: new Date('2026-07-12T00:00:00.000Z'),
    updatedAt: new Date('2026-07-12T00:00:00.000Z'),
    ...over,
  } as unknown as Awaited<ReturnType<InboxSources['native']>>[number];
}

const throwing = (label: string) => async () => {
  throw new Error(`boom: ${label} source unavailable (simulated schema drift)`);
};

describe('collectInboxItems fault isolation', () => {
  test('one failing source degrades to empty — the whole inbox does NOT throw', async () => {
    const sources: InboxSources = {
      native: async () => [nativeRow()],
      changeRequests: throwing('change_requests'),
      connectorApprovals: throwing('connector_calls'),
    };

    const { items } = await collectInboxItems(sources);

    // The native source survives; the two broken sources contribute nothing.
    expect(items).toHaveLength(1);
    expect(items[0].review_item_id).toBe('ri_1');
  });

  test('ALL sources failing yields an empty inbox, never a rejection', async () => {
    const sources: InboxSources = {
      native: throwing('native'),
      changeRequests: throwing('change_requests'),
      connectorApprovals: throwing('connector_calls'),
    };

    // The point of the fix: this must resolve to [], not reject → the route
    // returns 200 { review_items: [] } instead of 500.
    await expect(collectInboxItems(sources)).resolves.toEqual({ items: [], nextCursor: null });
  });

  test('a single un-serializable row is skipped, the rest of the source survives', async () => {
    const sources: InboxSources = {
      native: async () => [
        nativeRow({ reviewItemId: 'ri_ok' }),
        // createdAt=null makes serializeReviewItem throw on .toISOString()
        nativeRow({ reviewItemId: 'ri_bad', createdAt: null }),
        nativeRow({ reviewItemId: 'ri_ok2' }),
      ],
      changeRequests: async () => [],
      connectorApprovals: async () => [],
    };

    const { items } = await collectInboxItems(sources);
    const ids = items.map((i) => i.review_item_id).sort();
    expect(ids).toEqual(['ri_ok', 'ri_ok2']);
  });

  test('segment + kind filters still apply over the surviving items', async () => {
    const sources: InboxSources = {
      native: async () => [
        nativeRow({ reviewItemId: 'ri_needs', status: 'needs_you', kind: 'output' }),
        nativeRow({ reviewItemId: 'ri_done', status: 'done', kind: 'output' }),
        nativeRow({ reviewItemId: 'ri_decision', status: 'needs_you', kind: 'decision' }),
      ],
      changeRequests: async () => [],
      connectorApprovals: async () => [],
    };

    const { items: needsYou } = await collectInboxItems(sources, { segment: 'needs_you' });
    expect(needsYou.map((i) => i.review_item_id).sort()).toEqual(['ri_decision', 'ri_needs']);

    const { items: outputs } = await collectInboxItems(sources, { segment: 'needs_you', kind: 'output' });
    expect(outputs.map((i) => i.review_item_id)).toEqual(['ri_needs']);
  });
});

// KRTX-2316: the inbox is a bounded page. Needs you, then Waiting, then Done,
// newest first within each; a cursor walks the rest with no gap or repeat.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function crRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    crId: uuid(900),
    accountId: 'acc_1',
    projectId: 'proj_1',
    number: 1,
    title: 'A change',
    description: '',
    baseRef: 'main',
    headRef: 'feature',
    status: 'open',
    headCommitSha: null,
    baseCommitSha: null,
    originSessionId: null,
    createdBy: 'user_1',
    mergedAt: null,
    mergedBy: null,
    mergeCommitSha: null,
    closedAt: null,
    closedBy: null,
    metadata: {},
    createdAt: new Date('2026-07-12T00:00:00.000Z'),
    updatedAt: new Date('2026-07-12T00:00:00.000Z'),
    ...over,
  } as unknown as Awaited<ReturnType<InboxSources['changeRequests']>>[number];
}

/** Every page of a query, as review item ids, by following `nextCursor`. */
async function walk(sources: InboxSources, query: Parameters<typeof collectInboxItems>[1]) {
  const pages: string[][] = [];
  let after = null;
  for (let i = 0; i < 20; i += 1) {
    const page = await collectInboxItems(sources, { ...query, after });
    pages.push(page.items.map((item) => item.review_item_id));
    if (!page.nextCursor) return pages;
    after = decodeInboxCursor(page.nextCursor);
    expect(after).not.toBeNull();
  }
  throw new Error('the cursor never ended');
}

describe('collectInboxItems paging', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 6, 12, 0, minute));
  const sources: InboxSources = {
    native: async () => [
      nativeRow({ reviewItemId: uuid(1), status: 'done', createdAt: at(50) }),
      nativeRow({ reviewItemId: uuid(2), status: 'needs_you', createdAt: at(10) }),
      nativeRow({ reviewItemId: uuid(3), status: 'approved', createdAt: at(40) }),
      nativeRow({ reviewItemId: uuid(4), status: 'waiting', createdAt: at(20) }),
    ],
    changeRequests: async () => [
      crRow({ crId: uuid(5), status: 'merged', createdAt: at(45) }),
      crRow({ crId: uuid(6), status: 'open', createdAt: at(5) }),
    ],
    connectorApprovals: async () => [],
  };

  test('an unsegmented page starts with every pending item, then the newest done', async () => {
    const { items } = await collectInboxItems(sources, { limit: 3 });
    expect(items.map((item) => [item.review_item_id, item.status])).toEqual([
      [uuid(2), 'needs_you'],
      [`cr:${uuid(6)}`, 'needs_you'],
      [uuid(4), 'waiting'],
    ]);
  });

  test('the cursor walks every item once, in inbox order, and the last page has none', async () => {
    expect(await walk(sources, { limit: 2 })).toEqual([
      [uuid(2), `cr:${uuid(6)}`],
      [uuid(4), uuid(1)],
      [`cr:${uuid(5)}`, uuid(3)],
    ]);
  });

  test('a segment page holds that segment only, newest first', async () => {
    expect(await walk(sources, { segment: 'done', limit: 2 })).toEqual([
      [uuid(1), `cr:${uuid(5)}`],
      [uuid(3)],
    ]);
  });

  test('a session page holds the items that session raised', async () => {
    const scoped: InboxSources = {
      ...sources,
      native: async () => [
        nativeRow({ reviewItemId: uuid(1), originSessionId: uuid(100) }),
        nativeRow({ reviewItemId: uuid(2), originSessionId: uuid(101) }),
      ],
    };
    const { items } = await collectInboxItems(scoped, { sessionId: uuid(100) });
    expect(items.map((item) => item.review_item_id)).toEqual([uuid(1)]);
  });

  test('rows in the same millisecond page apart by their microseconds', async () => {
    const sameMs = new Date('2026-07-12T00:00:00.123Z');
    const tied: InboxSources = {
      native: async () => [
        { ...nativeRow({ reviewItemId: uuid(7), createdAt: sameMs }), sortAt: '2026-07-12T00:00:00.123100Z' },
        { ...nativeRow({ reviewItemId: uuid(8), createdAt: sameMs }), sortAt: '2026-07-12T00:00:00.123900Z' },
        { ...nativeRow({ reviewItemId: uuid(9), createdAt: sameMs }), sortAt: '2026-07-12T00:00:00.123500Z' },
      ],
      changeRequests: async () => [],
      connectorApprovals: async () => [],
    };
    expect(await walk(tied, { limit: 1 })).toEqual([[uuid(8)], [uuid(9)], [uuid(7)]]);
  });
});

describe('decodeInboxCursor', () => {
  test('reads back what encodeInboxCursor wrote', () => {
    const cursor = { rank: 2, at: '2026-07-12T00:00:00.123456Z', source: 1, id: uuid(5) };
    expect(decodeInboxCursor(encodeInboxCursor(cursor))).toEqual(cursor);
  });

  test('refuses anything this API did not issue', () => {
    const forge = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const raw of [
      'not-base64-json',
      forge({ rank: 0 }),
      forge([3, '2026-07-12T00:00:00.123456Z', 0, uuid(1)]),
      forge([0, '2026-07-12T00:00:00.123Z', 0, uuid(1)]),
      forge([0, '2026-07-12T00:00:00.123456Z', 0, "x' or 1=1 --"]),
    ]) {
      expect(decodeInboxCursor(raw)).toBeNull();
    }
  });
});

describe('changeRequestStatusesForSegment', () => {
  test('agrees with the status the adapter gives each change request', () => {
    for (const segment of ['needs_you', 'waiting', 'done'] as const) {
      for (const status of ['open', 'merged', 'closed'] as const) {
        const shown = changeRequestToReviewItem(crRow({ status })).status;
        expect(changeRequestStatusesForSegment(segment).includes(status)).toBe(
          statusesForSegment(segment).includes(shown),
        );
      }
    }
  });
});
