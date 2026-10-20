import { describe, expect, test } from 'bun:test';
import { createTranslator, defaultUiMessages } from '../../i18n';
import { MOCK_ITEMS } from './mock-data';
import {
  bulkResultMessage,
  bulkSelectable,
  bulkSkipMessage,
  bulkSupports,
  connectorCallId,
  crChangeRequestId,
  formatExpiresIn,
  formatItemAge,
  isApprovalExpiredError,
  formatItemAgeLong,
  isQuickDecidableApproval,
  itemDeepLink,
  resolveBulkOutcome,
} from './review-actions';
import type { ApprovalAction, ReviewItem, ReviewRisk } from './types';

describe('connectorCallId', () => {
  test('strips the call: prefix', () => {
    expect(connectorCallId('call:abc-123')).toBe('abc-123');
  });
  test('returns null for a non-exec id', () => {
    expect(connectorCallId('cr:abc-123')).toBeNull();
    expect(connectorCallId('rv-native-1')).toBeNull();
    expect(connectorCallId('')).toBeNull();
  });
});

describe('crChangeRequestId', () => {
  test('strips the cr: prefix', () => {
    expect(crChangeRequestId('cr:xyz-9')).toBe('xyz-9');
  });
  test('returns null for a non-cr id', () => {
    expect(crChangeRequestId('call:xyz-9')).toBeNull();
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

const approvalItem = (
  id: string,
  call: Partial<ApprovalAction> = {},
  extra: Partial<ReviewItem> = {},
): ReviewItem =>
  ({
    ...MOCK_ITEMS.find((i) => i.kind === 'approval')!,
    id,
    status: 'needs_you',
    expiresAt: undefined,
    detail: { actions: [{ ...call }] },
    ...extra,
  }) as ReviewItem;
const output = MOCK_ITEMS.find((i) => i.kind === 'output')!;
const all = () => true;

describe('bulkSupports: which bar verb acts on which row', () => {
  test('a connector approval takes Approve and Deny, never Dismiss', () => {
    const item = approvalItem('call:e1');
    expect(bulkSupports(item, 'approve', all)).toBe(true);
    expect(bulkSupports(item, 'deny', all)).toBe(true);
    expect(bulkSupports(item, 'dismiss', all)).toBe(false);
  });
  test('a native output takes Dismiss only', () => {
    expect(bulkSupports(output, 'approve', all)).toBe(false);
    expect(bulkSupports(output, 'deny', all)).toBe(false);
    expect(bulkSupports(output, 'dismiss', all)).toBe(true);
  });
  test('a change request takes no verb', () => {
    const cr = { ...output, id: 'cr:c1' } as ReviewItem;
    expect(bulkSelectable(cr, all)).toBe(false);
  });
  test('an approval whose content the viewer cannot read takes Deny, not Approve', () => {
    for (const call of [{ previewAuthorized: false }, { reviewComplete: false }]) {
      const item = approvalItem('call:e2', call);
      expect(bulkSupports(item, 'approve', all)).toBe(false);
      expect(bulkSupports(item, 'deny', all)).toBe(true);
    }
    // Arguments in view: reviewable even when the server marks it incomplete.
    const shown = approvalItem('call:e3', { reviewComplete: false, rawArgsPreview: { to: 'x' } });
    expect(bulkSupports(shown, 'approve', all)).toBe(true);
  });
  test('an expired, undecidable or finished approval takes nothing', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const expired = approvalItem('call:e4', {}, { expiresAt: '2026-10-20T11:59:00Z' });
    expect(bulkSupports(expired, 'approve', all, now)).toBe(false);
    expect(bulkSupports(expired, 'deny', all, now)).toBe(false);
    expect(bulkSelectable(approvalItem('call:e5', { canResolve: false }), all)).toBe(false);
    expect(bulkSelectable(approvalItem('call:e6', {}, { status: 'approved' }), all)).toBe(false);
  });
  test('a verdict the viewer may not give is not offered', () => {
    expect(bulkSelectable(approvalItem('call:e7'), () => false)).toBe(false);
    const approveOnly = (_: ReviewItem, verdict: string) => verdict === 'approve';
    expect(bulkSupports(approvalItem('call:e8'), 'deny', approveOnly)).toBe(false);
  });
});

describe('bulkResultMessage', () => {
  const t = createTranslator({
    locale: 'en',
    messages: defaultUiMessages,
    namespace: 'hardcodedUi.reviewBulk',
  });
  test('all ok', () => {
    expect(
      bulkResultMessage(t, 'approve', [
        { id: 'a', ok: true },
        { id: 'b', ok: true },
      ]),
    ).toBe('Approved 2');
  });
  test('ok plus skipped names each distinct reason once', () => {
    expect(
      bulkResultMessage(t, 'approve', [
        { id: 'a', ok: true },
        { id: 'b', ok: true },
        { id: 'c', ok: true },
        { id: 'd', ok: true },
        { id: 'e', ok: false, code: 'expired' },
      ]),
    ).toBe('Approved 4 · 1 skipped (expired)');
    expect(
      bulkResultMessage(t, 'deny', [
        { id: 'a', ok: false, code: 'expired' },
        { id: 'b', ok: false, code: 'already_resolved' },
        { id: 'c', ok: false, code: 'expired' },
      ]),
    ).toBe('3 skipped (expired, already decided)');
  });
  test('an unknown code reads as itself', () => {
    expect(bulkResultMessage(t, 'dismiss', [{ id: 'a', ok: false, code: 'new_code' }])).toBe(
      '1 skipped (new_code)',
    );
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
  test('a single-action connector approval requires the parameter-review modal', () => {
    expect(
      isQuickDecidableApproval({ kind: 'approval', id: 'call:e1', detail: { actions: [{}] } }),
    ).toBe(false);
  });
  test('an approval with no detail is not quick-decidable', () => {
    expect(isQuickDecidableApproval({ kind: 'approval', id: 'call:e1' })).toBe(false);
  });
  test('a multi-action approval needs the modal', () => {
    expect(
      isQuickDecidableApproval({
        kind: 'approval',
        id: 'call:e1',
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
    expect(isQuickDecidableApproval({ kind: 'change', id: 'call:e1' })).toBe(false);
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

describe('resolveBulkOutcome', () => {
  const risk =
    (m: Record<string, ReviewRisk>) =>
    (id: string): ReviewRisk | undefined =>
      m[id];

  test('dismiss NEVER answers an connector approval — exec ids are kept, not denied', () => {
    const out = resolveBulkOutcome(['call:e1', 'rv-1'], 'dismiss', risk({ 'call:e1': 'none' }));
    expect(out.act).toEqual(['rv-1']);
    expect(out.skippedApprovals).toEqual(['call:e1']);
    expect(out.skippedRisky).toEqual([]);
  });

  test('approve sweeps never answer connector approvals without individual parameter review', () => {
    const out = resolveBulkOutcome(
      ['call:safe', 'call:risky', 'rv-1'],
      'approve',
      risk({ 'call:safe': 'low', 'call:risky': 'high' }),
    );
    expect(out.act).toEqual(['rv-1']);
    expect(out.skippedRisky).toEqual([]);
    expect(out.skippedApprovals).toEqual(['call:safe', 'call:risky']);
  });

  test('an exec approval with unknown risk still requires individual review', () => {
    const out = resolveBulkOutcome(['call:mystery'], 'approve', risk({}));
    expect(out.act).toEqual([]);
    expect(out.skippedRisky).toEqual([]);
    expect(out.skippedApprovals).toEqual(['call:mystery']);
  });

  test('Change Requests are skipped under any verdict', () => {
    expect(resolveBulkOutcome(['cr:1'], 'approve', risk({})).skippedChanges).toEqual(['cr:1']);
    expect(resolveBulkOutcome(['cr:1'], 'dismiss', risk({})).skippedChanges).toEqual(['cr:1']);
  });

  test('native ids act under both verdicts', () => {
    expect(resolveBulkOutcome(['rv-1', 'rv-2'], 'dismiss', risk({})).act).toEqual(['rv-1', 'rv-2']);
    expect(resolveBulkOutcome(['rv-1'], 'approve', risk({})).act).toEqual(['rv-1']);
  });
});

describe('bulkSkipMessage', () => {
  test('empty when nothing was skipped', () => {
    expect(
      bulkSkipMessage({ act: ['a'], skippedRisky: [], skippedApprovals: [], skippedChanges: [] }),
    ).toBe('');
  });

  test('names every skip bucket with counts', () => {
    const msg = bulkSkipMessage({
      act: [],
      skippedRisky: ['call:r'],
      skippedApprovals: ['call:a', 'call:b'],
      skippedChanges: ['cr:1'],
    });
    expect(msg).toContain('2 approvals kept');
    expect(msg).toContain('1 risky approval skipped');
    expect(msg).toContain('1 change skipped');
  });
});

describe('formatExpiresIn', () => {
  const now = Date.parse('2026-07-01T10:00:00.000Z');
  test('time left in the row idiom; soon under one hour', () => {
    expect(formatExpiresIn('2026-07-01T13:00:00.000Z', now)).toEqual({ time: '3h', soon: false });
    expect(formatExpiresIn('2026-07-01T10:59:00.000Z', now)).toEqual({ time: '59m', soon: true });
    expect(formatExpiresIn('2026-07-03T10:00:00.000Z', now)).toEqual({ time: '2d', soon: false });
    // Floored: 59.6 min is "59m", never "1h" beside the under-one-hour glyph.
    expect(formatExpiresIn(new Date(now + 59.6 * 60_000).toISOString(), now)).toEqual({
      time: '59m',
      soon: true,
    });
    expect(formatExpiresIn(new Date(now + 150 * 60_000).toISOString(), now)?.time).toBe('2h');
  });
  test('no expiry, an unparseable value, or a past time has no label', () => {
    expect(formatExpiresIn(undefined, now)).toBeNull();
    expect(formatExpiresIn('not a date', now)).toBeNull();
    expect(formatExpiresIn('2026-07-01T09:59:00.000Z', now)).toBeNull();
  });
});

describe('isApprovalExpiredError', () => {
  test('only the APPROVAL_EXPIRED code counts', () => {
    expect(isApprovalExpiredError(Object.assign(new Error('x'), { code: 'APPROVAL_EXPIRED' }))).toBe(true);
    expect(isApprovalExpiredError(new Error('x'))).toBe(false);
    expect(isApprovalExpiredError(null)).toBe(false);
  });
});
