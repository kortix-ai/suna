import { describe, expect, test } from 'bun:test';

import {
  REVIEW_SEGMENTS,
  formatReviewAge,
  reviewItemTone,
  reviewKindLabel,
  reviewRiskLabel,
  reviewVerdictLabel,
  reviewVerdictToast,
  verdictNeedsConfirm,
  verdictNeedsFeedback,
} from './review-meta';

describe('REVIEW_SEGMENTS', () => {
  test('lists the three inbox segments in order', () => {
    expect(REVIEW_SEGMENTS).toEqual([
      { key: 'needs_you', label: 'Needs you' },
      { key: 'waiting', label: 'Waiting' },
      { key: 'done', label: 'Done' },
    ]);
  });
});

describe('labels', () => {
  test('names every kind', () => {
    expect(reviewKindLabel('change')).toBe('Change');
    expect(reviewKindLabel('approval')).toBe('Approval');
    expect(reviewKindLabel('output')).toBe('Output');
    expect(reviewKindLabel('decision')).toBe('Decision');
    expect(reviewKindLabel('batch')).toBe('Batch');
  });

  test('a verdict reads as the action it performs on that kind', () => {
    expect(reviewVerdictLabel('change', 'approve')).toBe('Merge');
    expect(reviewVerdictLabel('change', 'changes')).toBe('Request changes');
    expect(reviewVerdictLabel('change', 'dismiss')).toBe('Close');
    expect(reviewVerdictLabel('approval', 'approve')).toBe('Approve');
    expect(reviewVerdictLabel('approval', 'reject')).toBe('Deny');
    expect(reviewVerdictLabel('output', 'approve')).toBe('Approve');
    expect(reviewVerdictLabel('decision', 'dismiss')).toBe('Dismiss');
    expect(reviewVerdictLabel('batch', 'approve')).toBe('Approve all');
  });

  test('only medium and high risk carry a label', () => {
    expect(reviewRiskLabel('none')).toBeNull();
    expect(reviewRiskLabel('low')).toBeNull();
    expect(reviewRiskLabel('medium')).toBe('Medium risk');
    expect(reviewRiskLabel('high')).toBe('High risk');
  });
});

describe('verdict rules', () => {
  test('requesting changes needs feedback text; nothing else does', () => {
    expect(verdictNeedsFeedback('changes')).toBe(true);
    expect(verdictNeedsFeedback('approve')).toBe(false);
    expect(verdictNeedsFeedback('dismiss')).toBe(false);
  });

  test('a verdict that cannot be undone confirms first', () => {
    // Merging a change, running a connector call, and closing or denying.
    expect(verdictNeedsConfirm('change', 'approve')).toBe(true);
    expect(verdictNeedsConfirm('approval', 'approve')).toBe(true);
    expect(verdictNeedsConfirm('approval', 'reject')).toBe(true);
    expect(verdictNeedsConfirm('change', 'dismiss')).toBe(true);
    expect(verdictNeedsConfirm('output', 'approve')).toBe(false);
    expect(verdictNeedsConfirm('decision', 'answer')).toBe(false);
    expect(verdictNeedsConfirm('output', 'changes')).toBe(false);
  });
});

describe('formatReviewAge', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  test('minutes, hours, days', () => {
    expect(formatReviewAge('2026-09-21T11:55:00.000Z', now)).toBe('5m');
    expect(formatReviewAge('2026-09-21T09:00:00.000Z', now)).toBe('3h');
    expect(formatReviewAge('2026-09-19T12:00:00.000Z', now)).toBe('2d');
  });
  test('floors at one minute for a fresh or future timestamp', () => {
    expect(formatReviewAge('2026-09-21T11:59:50.000Z', now)).toBe('1m');
    expect(formatReviewAge('2026-09-21T12:05:00.000Z', now)).toBe('1m');
  });
  test('an unparseable timestamp yields an empty string', () => {
    expect(formatReviewAge('nope', now)).toBe('');
  });
});

describe('reviewItemTone', () => {
  test('an open item takes its kind colour, as on web', () => {
    expect(reviewItemTone('change', 'needs_you')).toBe('blue');
    expect(reviewItemTone('approval', 'needs_you')).toBe('orange');
    expect(reviewItemTone('output', 'needs_you')).toBe('purple');
    expect(reviewItemTone('decision', 'needs_you')).toBe('yellow');
    expect(reviewItemTone('batch', 'needs_you')).toBe('green');
  });

  test('a waiting item keeps its kind colour', () => {
    expect(reviewItemTone('change', 'waiting')).toBe('blue');
  });

  test('a finished item takes the colour of its outcome, whatever its kind', () => {
    expect(reviewItemTone('change', 'approved')).toBe('green');
    expect(reviewItemTone('decision', 'done')).toBe('green');
    expect(reviewItemTone('approval', 'rejected')).toBe('red');
    expect(reviewItemTone('output', 'changes_requested')).toBe('orange');
    expect(reviewItemTone('change', 'dismissed')).toBe('muted');
  });
});

describe('change verdicts', () => {
  test('a change offers Merge and Request changes; closing is not offered', () => {
    const { reviewVerdictsFor } = require('./review-verdict');
    expect(reviewVerdictsFor('change')).toEqual(['approve', 'changes']);
  });
});

describe('reviewVerdictToast', () => {
  test('a change names its number', () => {
    expect(reviewVerdictToast('change', 'approve', 8)).toBe('Change request #8 merged');
    expect(reviewVerdictToast('change', 'changes', 8)).toBe('Changes requested on #8');
    expect(reviewVerdictToast('change', 'dismiss', 8)).toBe('Change request #8 closed');
    expect(reviewVerdictToast('change', 'approve')).toBe('Change request merged');
  });

  test('other kinds name the verdict', () => {
    expect(reviewVerdictToast('approval', 'approve')).toBe('Approved');
    expect(reviewVerdictToast('approval', 'reject')).toBe('Denied');
    expect(reviewVerdictToast('decision', 'answer')).toBe('Answered');
    expect(reviewVerdictToast('output', 'changes')).toBe('Changes requested');
    expect(reviewVerdictToast('batch', 'dismiss')).toBe('Dismissed');
  });
});
