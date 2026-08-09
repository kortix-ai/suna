import { describe, expect, test } from 'bun:test';
import { extractSkillBaseDir, skillDocumentPath, skillInputDir } from './skill-helpers';

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

describe('skillDocumentPath — payload shapes the runtime might send', () => {
  // The producer is the OpenCode runtime, not this repo, so the exact shape
  // cannot be read from source. Every plausible one must resolve, because the
  // first attempt handled exactly one of them and did nothing for the rest.

  test('a dir attribute on the tag', () => {
    const out = `<skill_content name="webapp" dir="${DIR}">\n# Webapp\n</skill_content>`;
    expect(skillDocumentPath(out)).toBe(`${DIR}/SKILL.md`);
  });

  test('a path attribute, single-quoted', () => {
    const out = `<skill_content path='${DIR}'>\n# Webapp\n</skill_content>`;
    expect(skillDocumentPath(out)).toBe(`${DIR}/SKILL.md`);
  });

  test('a baseDir attribute with a trailing slash', () => {
    const out = `<skill_content baseDir="${DIR}/">\n# Webapp\n</skill_content>`;
    expect(skillDocumentPath(out)).toBe(`${DIR}/SKILL.md`);
  });

  test('a "Directory:" label rather than "Base directory:"', () => {
    expect(skillDocumentPath(output(`Directory: ${DIR}`))).toBe(`${DIR}/SKILL.md`);
  });

  test('the tag attribute wins over a stale label', () => {
    const out = `<skill_content dir="${DIR}">\nBase directory: /somewhere/else\n</skill_content>`;
    expect(skillDocumentPath(out)).toBe(`${DIR}/SKILL.md`);
  });
});

describe('skillDocumentPath — the install layout, when nothing says otherwise', () => {
  // The payload archaeology above was the wrong instinct. A skill's location is
  // not something to be recovered from the runtime's output at all: this product
  // OWNS where skills live. `injectManagedSkills` copies each one to
  // `<configDir>/skills/<name>/`, `resolveOpencodeConfigDir` defaults configDir
  // to `.kortix/opencode`, and the whole app already writes that path in prose
  // (entity-modal.tsx, use-configure-thread.ts). The skill's NAME is the join.

  test('a name alone is enough — no directory anywhere in the payload', () => {
    // This is the case that made three attempts do nothing on click. The runtime
    // sends `{ name }` and no location, every probe returned '', `onClick` came
    // out undefined, and `BasicTool` fell back to a disclosure — the collapsible.
    expect(skillDocumentPath('<skill_content>\n# Webapp\n</skill_content>', '', 'webapp')).toBe(
      '.kortix/opencode/skills/webapp/SKILL.md',
    );
  });

  test('a directory the runtime DID state still wins', () => {
    expect(skillDocumentPath(output(`Base directory: ${DIR}`), '', 'webapp')).toBe(
      `${DIR}/SKILL.md`,
    );
    expect(skillDocumentPath(output('# Webapp'), DIR, 'webapp')).toBe(`${DIR}/SKILL.md`);
  });

  test('a listed SKILL.md resolves against the conventional directory', () => {
    const out = output('<skill_files>\n<file>docs/SKILL.md</file>\n</skill_files>');
    expect(skillDocumentPath(out, '', 'webapp')).toBe(
      '.kortix/opencode/skills/webapp/docs/SKILL.md',
    );
  });

  test('the skills directory is flat, so a namespaced name uses its last segment', () => {
    expect(skillDocumentPath('', '', 'personal/webapp')).toBe(
      '.kortix/opencode/skills/webapp/SKILL.md',
    );
  });

  test('a name is trimmed of whitespace and slashes', () => {
    expect(skillDocumentPath('', '', '  webapp/  ')).toBe('.kortix/opencode/skills/webapp/SKILL.md');
  });

  test('a traversing name is refused rather than pointed outside the skills dir', () => {
    expect(skillDocumentPath('', '', '../../etc/passwd')).toBeNull();
    expect(skillDocumentPath('', '', '..')).toBeNull();
  });

  test('the placeholder name the row falls back to is not a skill', () => {
    // `SkillTool` renders `(input.name as string) || 'skill'`, so 'skill' can
    // mean "the call carried no name at all".
    expect(skillDocumentPath('', '', 'skill')).toBeNull();
    expect(skillDocumentPath('', '', '')).toBeNull();
    expect(skillDocumentPath('')).toBeNull();
  });
});

describe('skillInputDir', () => {
  test('finds the directory under any of the names the runtime may use', () => {
    expect(skillInputDir({ dir: DIR })).toBe(DIR);
    expect(skillInputDir({ directory: DIR })).toBe(DIR);
    expect(skillInputDir({ path: DIR })).toBe(DIR);
    expect(skillInputDir({ skillPath: `${DIR}/` })).toBe(DIR);
  });

  test('an input with only a name yields nothing', () => {
    expect(skillInputDir({ name: 'webapp' })).toBe('');
  });
});
