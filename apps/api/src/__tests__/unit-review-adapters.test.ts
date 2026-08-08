/**
 * Review Center adapters — Change Requests folded into the inbox read model.
 */
import { describe, expect, test } from 'bun:test';
import type { changeRequests, connectorCalls } from '@kortix/db';
import {
  CR_ID_PREFIX,
  CALL_ID_PREFIX,
  adapterSourceForId,
  changeRequestToReviewItem,
  connectorCallToReviewItem,
  isAdaptedId,
} from '../projects/review-adapters';

type ChangeRequestRow = typeof changeRequests.$inferSelect;
type ConnectorCallRow = typeof connectorCalls.$inferSelect;

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
  test('recognizes the cr: and call: prefixes; native ids are not adapted', () => {
    expect(adapterSourceForId('cr:abc')).toBe('cr');
    expect(adapterSourceForId('call:abc')).toBe('call');
    expect(adapterSourceForId('rv-native')).toBeNull();
    expect(isAdaptedId('cr:abc')).toBe(true);
    expect(isAdaptedId('call:abc')).toBe(true);
    expect(isAdaptedId('rv-native')).toBe(false);
  });
});

const baseCall: ConnectorCallRow = {
  executionId: 'ex-1',
  accountId: 'acc-1',
  projectId: 'proj-1',
  connectorId: 'conn-1',
  connectionId: null,
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

describe('connectorCallToReviewItem', () => {
  test('a pending connector call maps to a needs_you approval item', () => {
    const item = connectorCallToReviewItem(baseCall);
    expect(item.review_item_id).toBe(`${CALL_ID_PREFIX}ex-1`);
    expect(item.kind).toBe('approval');
    expect(item.status).toBe('needs_you');
    expect(item.title).toBe('Approve: gmail.messages.send');
    expect(item.detail).toMatchObject({
      execution_id: 'ex-1',
      action_path: 'gmail.messages.send',
    });
  });

  test('maps connector risk → review risk (read/write/destructive → low/medium/high)', () => {
    expect(connectorCallToReviewItem({ ...baseCall, risk: 'read' }).risk).toBe('low');
    expect(connectorCallToReviewItem({ ...baseCall, risk: 'write' }).risk).toBe('medium');
    expect(connectorCallToReviewItem({ ...baseCall, risk: 'destructive' }).risk).toBe('high');
    expect(connectorCallToReviewItem({ ...baseCall, risk: null }).risk).toBe('medium');
  });

  test('carries the complete redacted parameter preview into Review Center', () => {
    const argsPreview = {
      to: ['reviewer@example.com'],
      subject: 'Approval contract',
      body: 'The approver must see this body before deciding.',
      access_token: '[redacted]',
    };
    const item = connectorCallToReviewItem(
      {
        ...baseCall,
        resultSummary: {
          args_preview: argsPreview,
          args_preview_complete: true,
        },
      },
      { includeArgsPreview: true },
    );

    expect(item.detail).toMatchObject({
      args_preview: argsPreview,
      args_preview_complete: true,
      args_preview_authorized: true,
    });
  });

  test('withholds sensitive parameters when the caller lacks approval authority', () => {
    const item = connectorCallToReviewItem({
      ...baseCall,
      resultSummary: {
        args_preview: { to: ['private@example.com'], body: 'private body' },
        args_preview_complete: true,
      },
    });

    expect(item.detail).not.toHaveProperty('args_preview');
    expect(item.detail).toMatchObject({
      args_preview_complete: false,
      args_preview_authorized: false,
    });
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
    expect(item.detail).toMatchObject({
      cr_id: 'cr-1',
      number: 7,
      base_ref: 'main',
    });
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
    const item = changeRequestToReviewItem({
      ...baseCr,
      status: 'closed',
      closedBy: 'user-3',
    });
    expect(item.status).toBe('rejected');
    expect(item.acted_by).toBe('user-3');
  });

  test('an open CR with requested changes surfaces them but stays reviewable', () => {
    const item = changeRequestToReviewItem({
      ...baseCr,
      metadata: {
        requested_changes: [
          {
            text: 'Fix the first one',
            by: 'user-9',
            at: '2026-06-30T11:00:00.000Z',
          },
          {
            text: 'Capitalize each word',
            by: 'user-9',
            at: '2026-06-30T12:00:00.000Z',
          },
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
