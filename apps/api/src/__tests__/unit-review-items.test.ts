/**
 * Review Center core helpers — segment→status mapping, verdict/kind guards, and
 * the row→API serializer. Pure logic only (the DB queries are exercised by the
 * ke2e review flow).
 */
import { describe, expect, test } from 'bun:test';
import type { reviewItems } from '@kortix/db';
import {
  isReviewVerdict,
  isSubmittableKind,
  serializeReviewItem,
  statusesForSegment,
} from '../projects/review-items';

type ReviewItemRow = typeof reviewItems.$inferSelect;

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
