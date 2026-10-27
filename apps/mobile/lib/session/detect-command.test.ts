import { describe, expect, test } from 'bun:test';

import { detectCommandFromText } from './detect-command';

const PI_SKILL =
  '<skill name="content-creation" location="/opt/kortix/config/abc/skills/content-creation/SKILL.md">\nReferences are relative to /opt/kortix/config/abc/skills/content-creation.\n\n# Content Creation Skill\n\nWrite well.\n</skill>';

describe('detectCommandFromText', () => {
  test('a pi skill envelope names the skill and keeps only the prompt', () => {
    expect(detectCommandFromText(`${PI_SKILL}\n\nmake a launch video`)).toEqual({
      name: 'content-creation',
      args: 'make a launch video',
      source: 'skill',
    });
  });

  test('a SKILL.md that holds its own </skill> closes at the last one', () => {
    const nested = PI_SKILL.replace('Write well.', '<skill name="inner">body\n</skill>');
    expect(detectCommandFromText(`${nested}\n\nhi`)?.args).toBe('hi');
  });
});
