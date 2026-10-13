import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// KRTX-1720: the leaves and the mapping are the SDK's (`iam-actions.test.ts`
// covers member, update-only, manager and an unresolved probe), read through
// `useTriggerControls`. `../trigger-activation-menu.test.tsx` renders the
// pause-all gear per role.
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
