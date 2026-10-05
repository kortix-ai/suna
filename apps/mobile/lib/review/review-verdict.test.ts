import { describe, expect, test } from 'bun:test';

import { planReviewVerdict, reviewVerdictsFor } from './review-verdict';

describe('planReviewVerdict', () => {
  test('a native item acts through /act with its verdict and feedback', () => {
    expect(planReviewVerdict('rv-1', 'approve')).toEqual({
      call: 'act',
      reviewItemId: 'rv-1',
      verdict: 'approve',
      feedback: undefined,
    });
    expect(planReviewVerdict('rv-1', 'changes', 'Shorter headline')).toEqual({
      call: 'act',
      reviewItemId: 'rv-1',
      verdict: 'changes',
      feedback: 'Shorter headline',
    });
  });

  test('approving a change request merges it; dismissing closes it', () => {
    expect(planReviewVerdict('cr:42', 'approve')).toEqual({ call: 'merge', changeRequestId: '42' });
    expect(planReviewVerdict('cr:42', 'dismiss')).toEqual({ call: 'close', changeRequestId: '42' });
    expect(planReviewVerdict('cr:42', 'reject')).toEqual({ call: 'close', changeRequestId: '42' });
  });

  test('requesting changes on a change request carries the feedback', () => {
    expect(planReviewVerdict('cr:42', 'changes', 'Fix the footer')).toEqual({
      call: 'request_changes',
      changeRequestId: '42',
      feedback: 'Fix the footer',
    });
  });

  test('a change request has no "answer" verdict', () => {
    expect(planReviewVerdict('cr:42', 'answer')).toBeNull();
  });

  test('a connector call resolves through the approval flow, never /act', () => {
    expect(planReviewVerdict('call:exec-9', 'approve')).toEqual({
      call: 'resolve_approval',
      executionId: 'exec-9',
      decision: 'approve',
    });
    expect(planReviewVerdict('call:exec-9', 'reject')).toEqual({
      call: 'resolve_approval',
      executionId: 'exec-9',
      decision: 'deny',
    });
  });

  test('a connector call is never dismissed, answered, or sent back for changes', () => {
    expect(planReviewVerdict('call:exec-9', 'dismiss')).toBeNull();
    expect(planReviewVerdict('call:exec-9', 'answer')).toBeNull();
    expect(planReviewVerdict('call:exec-9', 'changes')).toBeNull();
  });
});

describe('reviewVerdictsFor', () => {
  test('lists the verdicts each kind offers, primary first', () => {
    // No Close on a change (Jay, 2026-09-21): merge it or send it back.
    expect(reviewVerdictsFor('change')).toEqual(['approve', 'changes']);
    expect(reviewVerdictsFor('approval')).toEqual(['approve', 'reject']);
    expect(reviewVerdictsFor('output')).toEqual(['approve', 'changes', 'dismiss']);
    expect(reviewVerdictsFor('decision')).toEqual(['answer', 'dismiss']);
    expect(reviewVerdictsFor('batch')).toEqual(['approve', 'dismiss']);
  });
});
