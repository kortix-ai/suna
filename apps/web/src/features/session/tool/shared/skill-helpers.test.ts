import { describe, expect, test } from 'bun:test';
import { extractSkillBaseDir, skillDocumentPath } from './skill-helpers';

const DIR = '/workspace/.opencode/skill/webapp';

const output = (body: string) => `<skill_content>\n${body}\n</skill_content>`;

describe('extractSkillBaseDir', () => {
  test('reads the line the tool prints', () => {
    expect(extractSkillBaseDir(output(`# Webapp\n\nBase directory: ${DIR}\n`))).toBe(DIR);
  });

  test('a trailing slash is dropped so joins never double up', () => {
    expect(extractSkillBaseDir(output(`Base directory: ${DIR}/`))).toBe(DIR);
  });

  test('no line, no directory — never a guess', () => {
    expect(extractSkillBaseDir(output('# Webapp'))).toBe('');
  });
});

describe('skillDocumentPath', () => {
  test('the base directory plus the conventional filename', () => {
    expect(skillDocumentPath(output(`Base directory: ${DIR}`))).toBe(`${DIR}/SKILL.md`);
  });

  test('works from `input.dir` alone, when the output carries no line', () => {
    expect(skillDocumentPath(output('# Webapp'), DIR)).toBe(`${DIR}/SKILL.md`);
  });

  test('works from the OUTPUT alone, when the call carries no dir', () => {
    // This is the case that made the first attempt do nothing on click: the
    // row keyed off `input.dir`, which the runtime need not send.
    expect(skillDocumentPath(output(`Base directory: ${DIR}`), undefined)).toBe(`${DIR}/SKILL.md`);
  });

  test('a SKILL.md the tool actually listed wins over the convention', () => {
    const out = output(
      `Base directory: ${DIR}\n<skill_files>\n<file>docs/SKILL.md</file>\n</skill_files>`,
    );
    expect(skillDocumentPath(out)).toBe(`${DIR}/docs/SKILL.md`);
  });

  test('an absolute listed path is used as-is', () => {
    const out = output(
      `Base directory: ${DIR}\n<skill_files>\n<file>/abs/elsewhere/SKILL.md</file>\n</skill_files>`,
    );
    expect(skillDocumentPath(out)).toBe('/abs/elsewhere/SKILL.md');
  });

  test('other listed files are not mistaken for the document', () => {
    const out = output(
      `Base directory: ${DIR}\n<skill_files>\n<file>reference.md</file>\n<file>templates/page.tsx</file>\n</skill_files>`,
    );
    expect(skillDocumentPath(out)).toBe(`${DIR}/SKILL.md`);
  });

  test('with nothing to go on it returns null rather than "/SKILL.md"', () => {
    // The row must not offer a click it cannot honour.
    expect(skillDocumentPath(output('# Webapp'))).toBeNull();
    expect(skillDocumentPath(output('# Webapp'), '   ')).toBeNull();
  });
});
