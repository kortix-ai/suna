/**
 * Review Center core helpers — segment→status mapping, verdict/kind guards, and
 * the row→API serializer. Pure logic only (the DB queries are exercised by the
 * ke2e review flow).
 */
import { describe, expect, test } from 'bun:test';
import type { executorExecutions, reviewItems } from '@kortix/db';
import {
  collectInboxItems,
  isReviewVerdict,
  isSubmittableKind,
  serializeReviewItem,
  statusesForSegment,
} from '../projects/review-items';

type ReviewItemRow = typeof reviewItems.$inferSelect;
type ExecutorExecutionRow = typeof executorExecutions.$inferSelect;

describe('statusesForSegment', () => {
  test('needs_you / waiting are single-status; done is every terminal status', () => {
    expect(statusesForSegment('needs_you')).toEqual(['needs_you']);
    expect(statusesForSegment('waiting')).toEqual(['waiting']);
    expect(statusesForSegment('done')).toEqual([
      'approved',
      'changes_requested',
      'rejected',
      'done',
      'dismissed',
    ]);
  });
});

describe('isReviewVerdict', () => {
  test('accepts the five verdicts and rejects everything else', () => {
    for (const v of ['approve', 'reject', 'changes', 'answer', 'dismiss']) {
      expect(isReviewVerdict(v)).toBe(true);
    }
    for (const v of ['', 'merge', 'APPROVE', null, undefined, 7]) {
      expect(isReviewVerdict(v)).toBe(false);
    }
  });
});

describe('isSubmittableKind', () => {
  test('only output/decision/batch are agent-submittable (not change/approval)', () => {
    expect(isSubmittableKind('output')).toBe(true);
    expect(isSubmittableKind('decision')).toBe(true);
    expect(isSubmittableKind('batch')).toBe(true);
    expect(isSubmittableKind('change')).toBe(false);
    expect(isSubmittableKind('approval')).toBe(false);
    expect(isSubmittableKind('nope')).toBe(false);
  });
});

describe('serializeReviewItem', () => {
  const base: ReviewItemRow = {
    reviewItemId: 'rv-1',
    accountId: 'acc-1',
    projectId: 'proj-1',
    originSessionId: 'sess-1',
    kind: 'output',
    status: 'needs_you',
    risk: 'low',
    source: 'agent',
    title: 'Review the landing page',
    summary: 'Built from the brief',
    detail: { artifactKind: 'page' },
    agent: 'Growth agent',
    createdBy: 'user-1',
    actedBy: null,
    actedAt: null,
    feedback: null,
    metadata: {},
    createdAt: new Date('2026-06-30T10:00:00.000Z'),
    updatedAt: new Date('2026-06-30T10:05:00.000Z'),
  };

  test('maps a pending row to the snake_case envelope with ISO dates', () => {
    const out = serializeReviewItem(base);
    expect(out.review_item_id).toBe('rv-1');
    expect(out.kind).toBe('output');
    expect(out.status).toBe('needs_you');
    expect(out.detail).toEqual({ artifactKind: 'page' });
    expect(out.created_at).toBe('2026-06-30T10:00:00.000Z');
    expect(out.updated_at).toBe('2026-06-30T10:05:00.000Z');
    expect(out.acted_at).toBeNull();
    expect(out.acted_by).toBeNull();
  });

  test('serializes an acted row (acted_at → ISO, feedback preserved)', () => {
    const acted: ReviewItemRow = {
      ...base,
      status: 'changes_requested',
      actedBy: 'user-2',
      actedAt: new Date('2026-06-30T11:00:00.000Z'),
      feedback: 'Punch up the headline',
    };
    const out = serializeReviewItem(acted);
    expect(out.status).toBe('changes_requested');
    expect(out.acted_by).toBe('user-2');
    expect(out.acted_at).toBe('2026-06-30T11:00:00.000Z');
    expect(out.feedback).toBe('Punch up the headline');
  });

  test('defaults a null detail/metadata to empty objects', () => {
    const out = serializeReviewItem({ ...base, detail: null as never, metadata: null });
    expect(out.detail).toEqual({});
    expect(out.metadata).toEqual({});
  });
});

describe('collectInboxItems executor preview authorization', () => {
  const execution: ExecutorExecutionRow = {
    executionId: 'exec-sensitive',
    accountId: 'acc-1',
    projectId: 'proj-1',
    connectorId: null,
    profileId: null,
    actionPath: 'gmail.send_email',
    actingUserId: 'user-1',
    sessionId: null,
    status: 'pending_approval',
    risk: 'write',
    requestDigest: 'digest',
    resultSummary: {
      args_preview: { to: ['private@example.com'], body: 'sensitive body' },
      args_preview_complete: true,
    },
    approvedBy: null,
    createdAt: new Date('2026-06-30T10:00:00.000Z'),
    resolvedAt: null,
  };
  const sources = {
    native: async () => [],
    changeRequests: async () => [],
    executorApprovals: async () => [execution],
  };

  test('fails closed when no preview-authority callback is provided', async () => {
    const [item] = await collectInboxItems(sources);
    expect(item.detail).not.toHaveProperty('args_preview');
    expect(item.detail).toMatchObject({
      args_preview_authorized: false,
      args_preview_complete: false,
    });
  });

  test('includes the full redacted preview only for an authorized execution', async () => {
    const [item] = await collectInboxItems(sources, {
      canExposeExecutorPreview: (row) => row.executionId === execution.executionId,
    });
    expect(item.detail).toMatchObject({
      args_preview: { to: ['private@example.com'], body: 'sensitive body' },
      args_preview_authorized: true,
      args_preview_complete: true,
    });
  });
});
