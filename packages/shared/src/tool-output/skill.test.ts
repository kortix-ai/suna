import { describe, expect, test } from 'bun:test';
import { skillDocumentBody } from './skill';
import { chooser, within } from './testing';

// The skill renderers' code, kept ONLY as the parity oracle.
function legacy(skillContent: string): string {
  return skillContent
    .trimStart()
    .replace(/<skill_files>[\s\S]*?<\/skill_files>/, '')
    .replace(/Base directory:.*$/m, '')
    .replace(/Note:.*relative to the base directory.*$/m, '')
    .trim();
}
const NOTE = /Note:.*relative to the base directory.*$/m;

describe('skillDocumentBody', () => {
  test('returns what the regex version returned on 3000 random skill outputs', () => {
    const { pick, some } = chooser(21);
    const pieces = [
      'Note: paths are relative to the base directory.',
      'Note: relative to the base directory',
      'Note: see the files below',
      'relative to the base directory',
      'Note:',
      'Note:Note:',
      'Base directory: /workspace/.opencode/skills/demo',
      '<skill_files>',
      '</skill_files>',
      '<file>a.md</file>',
      '# Demo skill',
      'x',
      ' ',
      '\t',
    ];
    const breaks = ['\n', '\n', '\r\n', '\r', '\u2028', '\u2029', ' '];
    let noted = 0;
    for (let i = 0; i < 3000; i++) {
      let text = some([' ', '\n'], 2);
      const lines = pick([1, 2, 3, 4, 5, 6]);
      for (let line = 0; line < lines; line++) text += some(pieces, 3) + pick(breaks);
      const expected = legacy(text);
      expect(skillDocumentBody(text)).toBe(expected);
      if (NOTE.test(text)) noted++;
    }
    expect(noted).toBeGreaterThan(600);
  });

  test('keeps the document and drops the runtime notes', () => {
    const output = [
      '',
      '# Demo',
      'Base directory: /workspace/skills/demo',
      'Use it well.',
      'Note: file references are relative to the base directory.',
      '<skill_files>',
      '<file>a.md</file>',
      '</skill_files>',
    ].join('\n');
    expect(skillDocumentBody(output)).toBe('# Demo\n\nUse it well.');
  });
});

describe('no skill output can freeze the renderer', () => {
  within('48k "Note:" on one line and no phrase (240k characters)', () =>
    skillDocumentBody('Note:'.repeat(48_000)),
  );
  within('40k lines that each start with "Note:" and no phrase', () =>
    skillDocumentBody('Note:\n'.repeat(40_000)),
  );
  within('18k <skill_files> that never close (234k characters)', () =>
    skillDocumentBody('<skill_files>'.repeat(18_000)),
  );
});
