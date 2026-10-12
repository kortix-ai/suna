import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { TRIGGER_CONTROL_ACTIONS, triggerControlsFrom } from './trigger-controls';

const allow = (allowed: boolean) => ({ allowed });

// KRTX-1720: every trigger control sat under one flag, derived from a
// different leaf on each page. A member (trigger.read + trigger.fire) saw no
// Run now; an update-only role saw Run now and Delete, and both 403'd.
describe('triggerControlsFrom', () => {
  test('each control follows the leaf its route asserts', () => {
    expect(TRIGGER_CONTROL_ACTIONS).toEqual([
      PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
      PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
      PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
      PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
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
      triggerControlsFrom({ [PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE]: allow(true) }),
    ).toEqual({ canCreate: false, canFire: false, canUpdate: true, canDelete: false });
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

describe('both trigger entry points read the same controls', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
  test('the Triggers page and the Agent page call useTriggerControls, and no trigger leaf by hand', () => {
    for (const path of [
      '../schedule-view.tsx',
      '../../../features/workspace/capabilities/agents/agent-triggers-section.tsx',
    ]) {
      const source = read(path);
      expect(source).toContain('useTriggerControls(');
      expect(source).not.toMatch(/useProjectCan\([^)]*PROJECT_TRIGGER_(CREATE|FIRE|DELETE)/);
    }
  });
});
