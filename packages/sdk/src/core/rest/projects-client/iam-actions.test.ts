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
import { PROJECT_ACTIONS, TRIGGER_CONTROL_ACTIONS, triggerControlsFrom } from './iam-actions';

const allow = (allowed: boolean) => ({ allowed });

describe('PROJECT_ACTIONS', () => {
  test('is the API catalog, key for key and leaf for leaf', () => {
    expect(PROJECT_ACTIONS).toEqual(API_PROJECT_ACTIONS);
  });

  test('the root entry exports the catalog and the trigger controls', () => {
    expect(root.PROJECT_ACTIONS).toBe(PROJECT_ACTIONS);
    expect(root.TRIGGER_CONTROL_ACTIONS).toBe(TRIGGER_CONTROL_ACTIONS);
    expect(root.triggerControlsFrom).toBe(triggerControlsFrom);
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
