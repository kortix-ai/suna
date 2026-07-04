/**
 * Review Center adapters — Change Requests folded into the inbox read model.
 */
import { describe, expect, test } from 'bun:test';
import type { changeRequests, executorExecutions } from '@kortix/db';
import {
  CR_ID_PREFIX,
  EXEC_ID_PREFIX,
  adapterSourceForId,
  changeRequestToReviewItem,
  executorExecutionToReviewItem,
  isAdaptedId,
} from '../projects/review-adapters';

type ChangeRequestRow = typeof changeRequests.$inferSelect;
type ExecutorExecutionRow = typeof executorExecutions.$inferSelect;

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

describe('adapterSourceForId / isAdaptedId', () => {
  test('recognizes the cr: and exec: prefixes; native ids are not adapted', () => {
    expect(adapterSourceForId('cr:abc')).toBe('cr');
    expect(adapterSourceForId('exec:abc')).toBe('exec');
    expect(adapterSourceForId('rv-native')).toBeNull();
    expect(isAdaptedId('cr:abc')).toBe(true);
    expect(isAdaptedId('exec:abc')).toBe(true);
    expect(isAdaptedId('rv-native')).toBe(false);
  });
});

const baseExec: ExecutorExecutionRow = {
  executionId: 'ex-1',
  accountId: 'acc-1',
  projectId: 'proj-1',
  connectorId: 'conn-1',
  actionPath: 'gmail.messages.send',
  actingUserId: 'user-1',
  sessionId: null,
  status: 'pending_approval',
  risk: 'destructive',
  requestDigest: 'sha-abc',
  resultSummary: null,
  approvedBy: null,
  createdAt: new Date('2026-06-30T09:00:00.000Z'),
  resolvedAt: null,
};

describe('executorExecutionToReviewItem', () => {
  test('a pending executor call maps to a needs_you approval item', () => {
    const item = executorExecutionToReviewItem(baseExec);
    expect(item.review_item_id).toBe(`${EXEC_ID_PREFIX}ex-1`);
    expect(item.kind).toBe('approval');
    expect(item.status).toBe('needs_you');
    expect(item.title).toBe('Approve: gmail.messages.send');
    expect(item.detail).toMatchObject({ execution_id: 'ex-1', action_path: 'gmail.messages.send' });
  });

  test('maps executor risk → review risk (read/write/destructive → low/medium/high)', () => {
    expect(executorExecutionToReviewItem({ ...baseExec, risk: 'read' }).risk).toBe('low');
    expect(executorExecutionToReviewItem({ ...baseExec, risk: 'write' }).risk).toBe('medium');
    expect(executorExecutionToReviewItem({ ...baseExec, risk: 'destructive' }).risk).toBe('high');
    expect(executorExecutionToReviewItem({ ...baseExec, risk: null }).risk).toBe('medium');
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

  test('an open CR with requested changes surfaces them but stays reviewable', () => {
    const item = changeRequestToReviewItem({
      ...baseCr,
      metadata: {
        requested_changes: [
          { text: 'Fix the first one', by: 'user-9', at: '2026-06-30T11:00:00.000Z' },
          { text: 'Capitalize each word', by: 'user-9', at: '2026-06-30T12:00:00.000Z' },
        ],
      },
    });
    // Open stays needs_you so you can always read the diff + ship (never stuck).
    expect(item.status).toBe('needs_you');
    // Top-level feedback reflects the latest note; detail carries the full log.
    expect(item.feedback).toBe('Capitalize each word');
    expect(item.detail).toMatchObject({
      requested_changes: [{ text: 'Fix the first one' }, { text: 'Capitalize each word' }],
    });
  });
});
