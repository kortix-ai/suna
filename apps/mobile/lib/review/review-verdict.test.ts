import { describe, expect, test } from 'bun:test';

import {
  REVIEW_CONTROL_ACTIONS,
  canOpenChangeRequest,
  planReviewVerdict,
  reviewVerdictAllowed,
  reviewVerdictsFor,
} from './review-verdict';

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

// KRTX-1720: every verdict showed for every viewer, and the API refused a
// member each one. A verdict now shows only when the viewer holds the leaves
// its route asserts.
describe('reviewVerdictAllowed', () => {
  const allow = (...leaves: string[]) =>
    Object.fromEntries(leaves.map((leaf) => [leaf, { allowed: true }]));
  const MANAGER = allow('project.write', 'project.gitops.push', 'project.gitops.merge', 'project.review.act');
  const MEMBER = allow();

  test('probes the leaves the review routes assert', () => {
    expect(REVIEW_CONTROL_ACTIONS).toEqual([
      'project.write',
      'project.gitops.push',
      'project.gitops.merge',
      'project.review.act',
    ]);
  });

  test('a manager may merge, close and send back a change, and act on a native item', () => {
    for (const verdict of ['approve', 'dismiss', 'changes'] as const) {
      expect(reviewVerdictAllowed('cr:42', verdict, MANAGER)).toBe(true);
    }
    for (const verdict of ['approve', 'changes', 'dismiss', 'answer'] as const) {
      expect(reviewVerdictAllowed('rv-1', verdict, MANAGER)).toBe(true);
    }
  });

  test('a built-in member may do none of them', () => {
    for (const verdict of ['approve', 'dismiss', 'changes'] as const) {
      expect(reviewVerdictAllowed('cr:42', verdict, MEMBER)).toBe(false);
    }
    expect(reviewVerdictAllowed('rv-1', 'approve', MEMBER)).toBe(false);
  });

  test('merge needs project.write + project.gitops.merge; review.act alone does not merge', () => {
    const reviewer = allow('project.write', 'project.review.act');
    expect(reviewVerdictAllowed('cr:42', 'approve', reviewer)).toBe(false);
    expect(reviewVerdictAllowed('cr:42', 'changes', reviewer)).toBe(true);
    expect(reviewVerdictAllowed('cr:42', 'dismiss', reviewer)).toBe(true);
    const merger = allow('project.write', 'project.gitops.merge');
    expect(reviewVerdictAllowed('cr:42', 'approve', merger)).toBe(true);
    expect(reviewVerdictAllowed('cr:42', 'changes', merger)).toBe(false);
  });

  test('every change and native verdict needs project.write: the routes load the project for write', () => {
    const noWrite = allow('project.gitops.merge', 'project.review.act');
    expect(reviewVerdictAllowed('cr:42', 'approve', noWrite)).toBe(false);
    expect(reviewVerdictAllowed('rv-1', 'approve', noWrite)).toBe(false);
  });

  test('a connector approval keeps its own per-call rule: the API sends no per-item verdict to gate on', () => {
    expect(reviewVerdictAllowed('call:exec-9', 'approve', MEMBER)).toBe(true);
    expect(reviewVerdictAllowed('call:exec-9', 'reject', MEMBER)).toBe(true);
  });

  test('a verdict the flow does not have is never allowed', () => {
    expect(reviewVerdictAllowed('call:exec-9', 'dismiss', MANAGER)).toBe(false);
  });

  test('an unresolved probe allows nothing on a change or a native item (fail closed)', () => {
    expect(reviewVerdictAllowed('cr:42', 'approve', {})).toBe(false);
    expect(reviewVerdictAllowed('rv-1', 'dismiss', {})).toBe(false);
  });

  test('+ (open a change request) needs project.write + project.gitops.push', () => {
    expect(canOpenChangeRequest(MANAGER)).toBe(true);
    expect(canOpenChangeRequest(MEMBER)).toBe(false);
    expect(canOpenChangeRequest(allow('project.gitops.push'))).toBe(false);
    expect(canOpenChangeRequest({})).toBe(false);
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
