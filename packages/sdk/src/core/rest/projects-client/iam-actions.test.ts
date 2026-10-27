/**
 * The project leaf catalog every host asks `useCan` / `useCans` about
 * (KRTX-1720). The API rejects an unknown leaf with 400, so a host that spells
 * a leaf by hand gets no verdict at all. These tests pin the catalog to the
 * API's own `PROJECT_ACTIONS`, and the trigger controls to the leaf each
 * trigger route asserts.
 */
import { describe, expect, test } from 'bun:test';
import { PROJECT_ACTIONS as API_PROJECT_ACTIONS } from '../../../../../../apps/api/src/iam/actions';
import * as root from '../../../index';
import {
  PROJECT_ACTIONS,
  REVIEW_CONTROL_ACTIONS,
  TRIGGER_CONTROL_ACTIONS,
  changeRequestControlsFrom,
  reviewVerdictAllowed,
  triggerControlsFrom,
} from './iam-actions';
import type { ReviewItem } from './review-items';

const allow = (allowed: boolean) => ({ allowed });

describe('PROJECT_ACTIONS', () => {
  test('is the API catalog, key for key and leaf for leaf', () => {
    expect(PROJECT_ACTIONS).toEqual(API_PROJECT_ACTIONS);
  });

  test('the root entry exports the catalog, the trigger controls and the review controls', () => {
    expect(root.PROJECT_ACTIONS).toBe(PROJECT_ACTIONS);
    expect(root.TRIGGER_CONTROL_ACTIONS).toBe(TRIGGER_CONTROL_ACTIONS);
    expect(root.triggerControlsFrom).toBe(triggerControlsFrom);
    expect(root.REVIEW_CONTROL_ACTIONS).toBe(REVIEW_CONTROL_ACTIONS);
    expect(root.changeRequestControlsFrom).toBe(changeRequestControlsFrom);
    expect(root.reviewVerdictAllowed).toBe(reviewVerdictAllowed);
  });
});

// KRTX-1720: every trigger control sat under one flag, derived from a
// different leaf on each page. A member (trigger.read + trigger.fire) saw no
// Run now; an update-only role saw Run now and Delete, and both answered 403.
// Create, update and delete load the project for write before they assert
// their trigger leaf (`loadProjectForUser(…, 'manage')` → project.write), so
// each needs both. Fire loads it for read only.
describe('triggerControlsFrom', () => {
  test('probes the leaves the trigger routes assert', () => {
    expect(TRIGGER_CONTROL_ACTIONS).toEqual([
      'project.write',
      'project.trigger.create',
      'project.trigger.fire',
      'project.trigger.update',
      'project.trigger.delete',
    ]);
  });

  test('a built-in member fires, and nothing else', () => {
    expect(
      triggerControlsFrom({
        [PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE]: allow(true),
        [PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE]: allow(false),
        [PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE]: allow(false),
        [PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE]: allow(false),
      }),
    ).toEqual({ canCreate: false, canFire: true, canUpdate: false, canDelete: false });
  });

  test('an update-only role edits and pauses, with no Run now and no Delete', () => {
    expect(
      triggerControlsFrom({
        [PROJECT_ACTIONS.PROJECT_WRITE]: allow(true),
        [PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE]: allow(true),
      }),
    ).toEqual({ canCreate: false, canFire: false, canUpdate: true, canDelete: false });
  });

  test('a trigger leaf without project.write offers nothing the route would refuse', () => {
    expect(
      triggerControlsFrom({
        [PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE]: allow(true),
        [PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE]: allow(true),
        [PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE]: allow(true),
        [PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE]: allow(true),
      }),
    ).toEqual({ canCreate: false, canFire: true, canUpdate: false, canDelete: false });
  });

  test('a manager gets every control', () => {
    const all = Object.fromEntries(TRIGGER_CONTROL_ACTIONS.map((action) => [action, allow(true)]));
    expect(triggerControlsFrom(all)).toEqual({
      canCreate: true,
      canFire: true,
      canUpdate: true,
      canDelete: true,
    });
  });

  test('an unresolved probe shows nothing (fail closed)', () => {
    expect(triggerControlsFrom({})).toEqual({
      canCreate: false,
      canFire: false,
      canUpdate: false,
      canDelete: false,
    });
  });
});

// KRTX-1720: web and mobile each mapped the review verdicts to leaves, and the
// copies disagreed. Web offered every verdict on project.review.act alone, but
// each verdict route loads the project for write first, so a review.act-only
// role got 403 on every click. Both hosts now read this one mapping.
const item = (id: string, kind: ReviewItem['kind'], detail: object = {}) =>
  ({ id, kind, detail }) as ReviewItem;
const leaves = (...granted: string[]) =>
  Object.fromEntries(granted.map((leaf) => [leaf, allow(true)]));
const {
  PROJECT_WRITE: WRITE,
  PROJECT_GITOPS_PUSH: PUSH,
  PROJECT_GITOPS_MERGE: MERGE,
  PROJECT_REVIEW_ACT: ACT,
} = PROJECT_ACTIONS;
const MANAGER = leaves(WRITE, PUSH, MERGE, ACT);
// A built-in member holds review.read + review.submit: none of these leaves.
const MEMBER = {};

describe('changeRequestControlsFrom', () => {
  test('probes the leaves the review and change request routes assert', () => {
    expect(REVIEW_CONTROL_ACTIONS).toEqual([
      'project.write',
      'project.gitops.push',
      'project.gitops.merge',
      'project.review.act',
    ]);
  });

  test('a manager opens, merges and closes a change request', () => {
    expect(changeRequestControlsFrom(MANAGER)).toEqual({
      canOpen: true,
      canMerge: true,
      canClose: true,
    });
  });

  test('a built-in member does none of them', () => {
    expect(changeRequestControlsFrom(MEMBER)).toEqual({
      canOpen: false,
      canMerge: false,
      canClose: false,
    });
  });

  test('merge needs project.write + project.gitops.merge; review.act does not merge', () => {
    expect(changeRequestControlsFrom(leaves(WRITE, ACT)).canMerge).toBe(false);
    expect(changeRequestControlsFrom(leaves(MERGE)).canMerge).toBe(false);
    expect(changeRequestControlsFrom(leaves(WRITE, MERGE)).canMerge).toBe(true);
  });

  test('open needs project.write + project.gitops.push', () => {
    expect(changeRequestControlsFrom(leaves(PUSH)).canOpen).toBe(false);
    expect(changeRequestControlsFrom(leaves(WRITE, PUSH)).canOpen).toBe(true);
  });

  test('close and reopen need project.write only, as their routes assert', () => {
    expect(changeRequestControlsFrom(leaves(WRITE))).toEqual({
      canOpen: false,
      canMerge: false,
      canClose: true,
    });
  });
});

describe('reviewVerdictAllowed', () => {
  const CHANGE = item('cr:42', 'change');
  const OUTPUT = item('rv-1', 'output');
  const call = (previewAuthorized?: boolean) =>
    item('call:exec-9', 'approval', { actions: [{ id: 'exec-9', previewAuthorized }] });

  test('a manager merges, closes and sends back a change, and acts on a native item', () => {
    for (const verdict of ['approve', 'dismiss', 'reject', 'changes'] as const) {
      expect(reviewVerdictAllowed(CHANGE, verdict, MANAGER)).toBe(true);
    }
    for (const verdict of ['approve', 'reject', 'changes', 'dismiss', 'answer'] as const) {
      expect(reviewVerdictAllowed(OUTPUT, verdict, MANAGER)).toBe(true);
    }
  });

  test('a built-in member gives no verdict on a change or a native item', () => {
    for (const verdict of ['approve', 'dismiss', 'changes'] as const) {
      expect(reviewVerdictAllowed(CHANGE, verdict, MEMBER)).toBe(false);
      expect(reviewVerdictAllowed(OUTPUT, verdict, MEMBER)).toBe(false);
    }
  });

  test('review.act without project.write gives no verdict: each verdict route loads the project for write', () => {
    const noWrite = leaves(ACT, MERGE);
    for (const verdict of ['approve', 'dismiss', 'changes'] as const) {
      expect(reviewVerdictAllowed(CHANGE, verdict, noWrite)).toBe(false);
      expect(reviewVerdictAllowed(OUTPUT, verdict, noWrite)).toBe(false);
    }
  });

  test('approving a change merges it: write + gitops.merge, not review.act', () => {
    const reviewer = leaves(WRITE, ACT);
    expect(reviewVerdictAllowed(CHANGE, 'approve', reviewer)).toBe(false);
    expect(reviewVerdictAllowed(CHANGE, 'changes', reviewer)).toBe(true);
    expect(reviewVerdictAllowed(CHANGE, 'dismiss', reviewer)).toBe(true);
    const merger = leaves(WRITE, MERGE);
    expect(reviewVerdictAllowed(CHANGE, 'approve', merger)).toBe(true);
    expect(reviewVerdictAllowed(CHANGE, 'changes', merger)).toBe(false);
  });

  test('a change request has no answer verdict', () => {
    expect(reviewVerdictAllowed(CHANGE, 'answer', MANAGER)).toBe(false);
  });

  test('a connector call is approved or denied by whoever the API lets resolve it', () => {
    // A manager, or the person who launched the session: the API sends the
    // call's arguments, whatever leaves the viewer holds.
    expect(reviewVerdictAllowed(call(true), 'approve', MEMBER)).toBe(true);
    expect(reviewVerdictAllowed(call(true), 'reject', MEMBER)).toBe(true);
    // Anyone else: the API withholds the arguments and refuses the decision.
    expect(reviewVerdictAllowed(call(false), 'approve', MANAGER)).toBe(false);
    expect(reviewVerdictAllowed(call(false), 'reject', MANAGER)).toBe(false);
  });

  test('a connector call is decided only by a viewer the API says can resolve it (KRTX-1724)', () => {
    const resolvable = (canResolve: boolean) =>
      item('call:exec-9', 'approval', {
        actions: [{ id: 'exec-9', previewAuthorized: true, canResolve }],
      });
    expect(reviewVerdictAllowed(resolvable(true), 'approve', MEMBER)).toBe(true);
    expect(reviewVerdictAllowed(resolvable(true), 'reject', MEMBER)).toBe(true);
    expect(reviewVerdictAllowed(resolvable(false), 'approve', MANAGER)).toBe(false);
    expect(reviewVerdictAllowed(resolvable(false), 'reject', MANAGER)).toBe(false);
  });

  test('a connector call is never dismissed, answered or sent back', () => {
    for (const verdict of ['dismiss', 'answer', 'changes'] as const) {
      expect(reviewVerdictAllowed(call(true), verdict, MANAGER)).toBe(false);
    }
  });

  test('an unresolved probe allows nothing on a change or a native item (fail closed)', () => {
    expect(reviewVerdictAllowed(CHANGE, 'approve', {})).toBe(false);
    expect(reviewVerdictAllowed(OUTPUT, 'dismiss', {})).toBe(false);
  });
});
