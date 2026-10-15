import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GENUI_SKILL_DESCRIPTION, GENUI_SKILL_PATH, genuiSkillMarkdown } from '../../scripts/genui-skill';
import { buildGenuiPrompt } from './prompt';

describe('kortix-genui system skill', () => {
  test('the committed SKILL.md is the generated one (run: bun packages/sdk/scripts/genui-skill.ts)', () => {
    expect(readFileSync(fileURLToPath(GENUI_SKILL_PATH), 'utf8')).toBe(genuiSkillMarkdown());
  });
  test('carries the whole prompt under a valid skill frontmatter', () => {
    const md = genuiSkillMarkdown();
    expect(md.startsWith('---\nname: kortix-genui\ndescription: ')).toBe(true);
    expect(md).toContain(buildGenuiPrompt());
  });
  test('the description fits the skill limits and names the triggers', () => {
    expect(GENUI_SKILL_DESCRIPTION.length).toBeGreaterThan(0);
    expect(GENUI_SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024);
    expect(GENUI_SKILL_DESCRIPTION).not.toContain('"');
    for (const word of ['cards', 'chart', 'table', 'map']) expect(GENUI_SKILL_DESCRIPTION).toContain(word);
  });
});
