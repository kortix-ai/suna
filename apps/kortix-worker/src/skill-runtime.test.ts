import { describe, expect, test } from 'bun:test';

import { PermissionBroker, PermissionDeniedError } from './permission-broker.ts';
import { protectToolsWithPermissions } from './permission-tools.ts';
import { type PiSkill, createSkillTool, projectSkillInfo } from './skill-runtime.ts';

const skills: PiSkill[] = [
  {
    name: 'release',
    description: 'Prepare a release',
    location: '.kortix/pi/skills/release/SKILL.md',
    content: 'Run the release workflow.',
    files: ['references/policy.md', 'scripts/release.ts'],
  },
];

describe('Pi skill runtime', () => {
  test('projects OpenCode skill metadata onto the environment workspace', () => {
    const skill = skills[0];
    if (!skill) throw new Error('test skill is missing');
    expect(projectSkillInfo(skill, '/workspace')).toEqual({
      name: 'release',
      description: 'Prepare a release',
      location: '/workspace/.kortix/pi/skills/release/SKILL.md',
      content: 'Run the release workflow.',
    });
  });

  test('loads compiled Markdown and advertises environment support paths without local I/O', async () => {
    const tool = createSkillTool(skills, '/workspace');
    expect(tool.description).toContain('<name>release</name>');
    const result = await tool.execute('call_1', { name: 'release' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('<skill_content name="release">');
    expect(text).toContain('Run the release workflow.');
    expect(text).toContain('Base directory for this skill: /workspace/.kortix/pi/skills/release');
    expect(text).toContain('<file>/workspace/.kortix/pi/skills/release/scripts/release.ts</file>');
    expect(result.details).toEqual({
      name: 'release',
      dir: '/workspace/.kortix/pi/skills/release',
    });
  });

  test('uses the skill ID as the permission resource and denies before loading content', async () => {
    let asked = 0;
    const broker = new PermissionBroker({
      sessionId: 'ses_skill',
      permission: { skill: { '*': 'allow', release: 'deny' } },
      publish: () => {
        asked += 1;
      },
    });
    const [tool] = protectToolsWithPermissions(
      [createSkillTool(skills, '/workspace')],
      broker,
      '/workspace',
    );
    if (!tool) throw new Error('skill tool was not registered');

    await expect(tool.execute('call_1', { name: 'release' })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(asked).toBe(0);
  });

  test('waits for an ask reply before returning compiled instructions', async () => {
    const broker = new PermissionBroker({
      sessionId: 'ses_skill',
      permission: { skill: { release: 'ask' } },
      publish: () => {},
      createId: () => 'per_skill',
    });
    const [tool] = protectToolsWithPermissions(
      [createSkillTool(skills, '/workspace')],
      broker,
      '/workspace',
    );
    if (!tool) throw new Error('skill tool was not registered');

    const execution = tool.execute('call_1', { name: 'release' });
    await Promise.resolve();
    expect(broker.list()).toEqual([
      expect.objectContaining({
        id: 'per_skill',
        permission: 'skill',
        patterns: ['release'],
        always: ['release'],
      }),
    ]);
    expect(broker.reply('per_skill', 'once')).toBe(true);
    const result = await execution;
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });
});
