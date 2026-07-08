import { describe, expect, test } from 'bun:test';
import {
  crChangeRequestId,
  execExecutionId,
  formatItemAge,
  formatItemAgeLong,
  isQuickDecidableApproval,
  itemDeepLink,
  planBulkAction,
} from './review-actions';

describe('execExecutionId', () => {
  test('strips the exec: prefix', () => {
    expect(execExecutionId('exec:abc-123')).toBe('abc-123');
  });
  test('returns null for a non-exec id', () => {
    expect(execExecutionId('cr:abc-123')).toBeNull();
    expect(execExecutionId('rv-native-1')).toBeNull();
    expect(execExecutionId('')).toBeNull();
  });
});

describe('crChangeRequestId', () => {
  test('strips the cr: prefix', () => {
    expect(crChangeRequestId('cr:xyz-9')).toBe('xyz-9');
  });
  test('returns null for a non-cr id', () => {
    expect(crChangeRequestId('exec:xyz-9')).toBeNull();
    expect(crChangeRequestId('rv-native-1')).toBeNull();
  });
});

describe('itemDeepLink', () => {
  test('builds the session route when both ids are present', () => {
    expect(itemDeepLink('proj-1', 'sess-1')).toBe('/projects/proj-1/sessions/sess-1');
  });
  test('is null without a session id (nothing to deep-link into)', () => {
    expect(itemDeepLink('proj-1', undefined)).toBeNull();
    expect(itemDeepLink('proj-1', null)).toBeNull();
    expect(itemDeepLink('proj-1', '')).toBeNull();
  });
  test('is null without a project id', () => {
    expect(itemDeepLink('', 'sess-1')).toBeNull();
  });
});

describe('planBulkAction', () => {
  test('buckets ids by how the inbox can act on them', () => {
    const plan = planBulkAction(['rv-1', 'exec:e1', 'cr:c1', 'rv-2', 'exec:e2']);
    expect(plan.native).toEqual(['rv-1', 'rv-2']);
    expect(plan.resolvable).toEqual(['exec:e1', 'exec:e2']);
    expect(plan.unsupported).toEqual(['cr:c1']);
  });
  test('accepts a Set and handles an all-native selection', () => {
    const plan = planBulkAction(new Set(['rv-1', 'rv-2']));
    expect(plan).toEqual({ native: ['rv-1', 'rv-2'], resolvable: [], unsupported: [] });
  });
  test('empty selection yields empty buckets', () => {
    expect(planBulkAction([])).toEqual({ native: [], resolvable: [], unsupported: [] });
  });
});

describe('formatItemAge', () => {
  const base = new Date('2026-07-08T12:00:00.000Z').getTime();
  test('minutes under an hour', () => {
    expect(formatItemAge(new Date(base - 7 * 60_000).toISOString(), base)).toBe('7m');
  });
  test('floors at 1 minute for sub-minute / future timestamps', () => {
    expect(formatItemAge(new Date(base).toISOString(), base)).toBe('1m');
    expect(formatItemAge(new Date(base + 60_000).toISOString(), base)).toBe('1m');
  });
  test('hours under a day', () => {
    expect(formatItemAge(new Date(base - 3 * 3_600_000).toISOString(), base)).toBe('3h');
  });
  test('days at or beyond 24 hours', () => {
    expect(formatItemAge(new Date(base - 50 * 3_600_000).toISOString(), base)).toBe('2d');
  });
});

describe('isQuickDecidableApproval', () => {
  test('a single-action executor approval is quick-decidable', () => {
    expect(
      isQuickDecidableApproval({ kind: 'approval', id: 'exec:e1', detail: { actions: [{}] } }),
    ).toBe(true);
  });
  test('an approval with no detail (defensive) is quick-decidable', () => {
    expect(isQuickDecidableApproval({ kind: 'approval', id: 'exec:e1' })).toBe(true);
  });
  test('a multi-action approval needs the modal', () => {
    expect(
      isQuickDecidableApproval({
        kind: 'approval',
        id: 'exec:e1',
        detail: { actions: [{}, {}] },
      }),
    ).toBe(false);
  });
  test('a Change Request approval-kind lookalike is not quick-decidable (not an exec id)', () => {
    expect(
      isQuickDecidableApproval({ kind: 'approval', id: 'rv-native-1', detail: { actions: [{}] } }),
    ).toBe(false);
  });
  test('non-approval kinds are never quick-decidable', () => {
    expect(isQuickDecidableApproval({ kind: 'change', id: 'exec:e1' })).toBe(false);
  });
});

describe('formatItemAgeLong', () => {
  const base = new Date('2026-07-08T12:00:00.000Z').getTime();
  test('appends "ago" at every scale', () => {
    expect(formatItemAgeLong(new Date(base - 7 * 60_000).toISOString(), base)).toBe('7m ago');
    expect(formatItemAgeLong(new Date(base - 3 * 3_600_000).toISOString(), base)).toBe('3h ago');
    expect(formatItemAgeLong(new Date(base - 50 * 3_600_000).toISOString(), base)).toBe('2d ago');
  });
});
