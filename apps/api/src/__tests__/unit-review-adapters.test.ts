/**
 * Review Center adapters — Change Requests folded into the inbox read model.
 */
import { describe, expect, test } from 'bun:test';
import type { changeRequests } from '@kortix/db';
import {
  CR_ID_PREFIX,
  adapterSourceForId,
  changeRequestToReviewItem,
} from '../projects/review-adapters';

type ChangeRequestRow = typeof changeRequests.$inferSelect;

const baseCr: ChangeRequestRow = {
  crId: 'cr-1',
  accountId: 'acc-1',
  projectId: 'proj-1',
  number: 7,
  title: 'Refresh the pricing page',
  description: 'Updated copy',
  baseRef: 'main',
  headRef: 'session/pricing',
  status: 'open',
  headCommitSha: 'abc123',
  baseCommitSha: 'def456',
  originSessionId: 'sess-1',
  createdBy: 'user-1',
  mergedAt: null,
  mergedBy: null,
  mergeCommitSha: null,
  closedAt: null,
  closedBy: null,
  metadata: {},
  createdAt: new Date('2026-06-30T10:00:00.000Z'),
  updatedAt: new Date('2026-06-30T10:00:00.000Z'),
};

describe('adapterSourceForId', () => {
  test('recognizes the cr: prefix and nothing else', () => {
    expect(adapterSourceForId('cr:abc')).toBe('cr');
    expect(adapterSourceForId('rv-native')).toBeNull();
  });
});

describe('changeRequestToReviewItem', () => {
  test('an open CR maps to a needs_you change item with a namespaced id', () => {
    const item = changeRequestToReviewItem(baseCr);
    expect(item.review_item_id).toBe(`${CR_ID_PREFIX}cr-1`);
    expect(item.kind).toBe('change');
    expect(item.status).toBe('needs_you');
    expect(item.title).toBe('Refresh the pricing page');
    expect(item.summary).toBe('#7 · session/pricing → main');
    expect(item.detail).toMatchObject({ cr_id: 'cr-1', number: 7, base_ref: 'main' });
    expect(item.acted_at).toBeNull();
    expect(item.created_at).toBe('2026-06-30T10:00:00.000Z');
  });

  test('a merged CR maps to approved with the merge actor + time', () => {
    const item = changeRequestToReviewItem({
      ...baseCr,
      status: 'merged',
      mergedBy: 'user-2',
      mergedAt: new Date('2026-06-30T12:00:00.000Z'),
    });
    expect(item.status).toBe('approved');
    expect(item.acted_by).toBe('user-2');
    expect(item.acted_at).toBe('2026-06-30T12:00:00.000Z');
  });

  test('a closed CR maps to rejected', () => {
    const item = changeRequestToReviewItem({ ...baseCr, status: 'closed', closedBy: 'user-3' });
    expect(item.status).toBe('rejected');
    expect(item.acted_by).toBe('user-3');
  });
});
