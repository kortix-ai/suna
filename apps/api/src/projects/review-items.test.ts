import { describe, expect, test } from 'bun:test';

import { type InboxSources, collectInboxItems } from './review-items';

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
      executorApprovals: throwing('executor_executions'),
      sandboxPermissions: async () => [],
    };

    const items = await collectInboxItems(sources);

    // The native source survives; the two broken sources contribute nothing.
    expect(items).toHaveLength(1);
    expect(items[0].review_item_id).toBe('ri_1');
  });

  test('ALL sources failing yields an empty inbox, never a rejection', async () => {
    const sources: InboxSources = {
      native: throwing('native'),
      changeRequests: throwing('change_requests'),
      executorApprovals: throwing('executor_executions'),
      sandboxPermissions: async () => [],
    };

    // The point of the fix: this must resolve to [], not reject → the route
    // returns 200 { review_items: [] } instead of 500.
    await expect(collectInboxItems(sources)).resolves.toEqual([]);
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
      executorApprovals: async () => [],
      sandboxPermissions: async () => [],
    };

    const items = await collectInboxItems(sources);
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
      executorApprovals: async () => [],
      sandboxPermissions: async () => [],
    };

    const needsYou = await collectInboxItems(sources, { segment: 'needs_you' });
    expect(needsYou.map((i) => i.review_item_id).sort()).toEqual(['ri_decision', 'ri_needs']);

    const outputs = await collectInboxItems(sources, { segment: 'needs_you', kind: 'output' });
    expect(outputs.map((i) => i.review_item_id)).toEqual(['ri_needs']);
  });
});
