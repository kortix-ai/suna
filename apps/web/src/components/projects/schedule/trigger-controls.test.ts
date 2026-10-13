import * as SDK from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRIGGER_CONTROL_ACTIONS, triggerControlsFrom } from './trigger-controls';

// KRTX-1720: the leaves and the mapping are the SDK's (`iam-actions.test.ts`
// covers member, update-only, manager and an unresolved probe). Web reads them
// through this module, so mobile and web cannot drift.
test('the web hook reads the SDK trigger controls', () => {
  expect(TRIGGER_CONTROL_ACTIONS).toBe(SDK.TRIGGER_CONTROL_ACTIONS);
  expect(triggerControlsFrom).toBe(SDK.triggerControlsFrom);
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
