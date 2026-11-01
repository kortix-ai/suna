import { expect, test } from 'bun:test';
import { getManagedSkillFiles, getStarterFiles, STARTER_TEMPLATE_IDS } from './index';

test('app builders receive the design requirement and its managed skill', () => {
  const files = getManagedSkillFiles();
  const apps = files.find((file) => file.path === 'skills/kortix-apps/SKILL.md');
  expect(apps?.content).toContain('including delegated app builders');
  expect(apps?.content).toContain('internal app');
  const design = files.find((file) => file.path === 'skills/kortix-design/SKILL.md');
  expect(design?.content).toContain("The user's style comes first.");
  expect(design?.content).toContain('`kortix-ui` and use its tokens');
  for (const template of STARTER_TEMPLATE_IDS) {
    const worker = getStarterFiles({ projectName: 'Synthetic', template })
      .find((file) => file.path === 'agents/worker.md');
    expect(worker?.content).toContain('kortix-design');
    expect(worker?.content).toContain('delegat');
  }
});
