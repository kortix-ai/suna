import { describe, expect, test } from 'bun:test';

import { buildFileTree, entityDirectory, isMarkdownPath, languageForPath } from './skill-files';

describe('entityDirectory', () => {
  test('strips the file name', () => {
    expect(entityDirectory('.opencode/skill/podcast/SKILL.md')).toBe('.opencode/skill/podcast');
  });
  test('strips a fragment before splitting', () => {
    expect(entityDirectory('.opencode/skill/podcast/SKILL.md#frontmatter')).toBe(
      '.opencode/skill/podcast',
    );
  });
  test('a root-level file has no directory', () => {
    expect(entityDirectory('AGENTS.md')).toBe('');
  });
  // Real project data (`.kortix/opencode/skills/<name>/SKILL.md`) uses a
  // different prefix than the `.opencode/skill/` shape above — the function
  // must derive the directory from whatever prefix the path actually carries,
  // never assume one.
  test('works for the real .kortix/opencode/skills prefix', () => {
    expect(entityDirectory('.kortix/opencode/skills/docx/SKILL.md')).toBe(
      '.kortix/opencode/skills/docx',
    );
  });
});

describe('buildFileTree', () => {
  const dir = '.opencode/skill/podcast';

  test('sorts SKILL.md first, then nested paths alphabetically', () => {
    const tree = buildFileTree(
      [
        `${dir}/references/example.md`,
        `${dir}/SKILL.md`,
        `${dir}/references/aaa.md`,
        '.opencode/skill/other/SKILL.md',
      ],
      dir,
    );
    expect(tree.map((n) => n.path)).toEqual([
      `${dir}/SKILL.md`,
      `${dir}/references/aaa.md`,
      `${dir}/references/example.md`,
    ]);
  });

  test('depth counts segments below the directory', () => {
    const tree = buildFileTree([`${dir}/SKILL.md`, `${dir}/references/aaa.md`], dir);
    expect(tree.map((n) => n.depth)).toEqual([0, 1]);
  });

  test('name is the basename', () => {
    const tree = buildFileTree([`${dir}/references/aaa.md`], dir);
    expect(tree[0]?.name).toBe('aaa.md');
  });

  test('a single-file entity yields one node', () => {
    expect(buildFileTree(['.opencode/command/ship.md'], '.opencode/command')).toHaveLength(1);
  });

  // Real fixture: the `docx` skill, 12 files across three depths
  // (`.kortix/opencode/skills/docx/…`, `scripts/…`, `scripts/templates/…`).
  // Confirmed live in the browser against this exact skill (task-5 review):
  // sorting the joined path as one string put `scripts/templates/comments.xml`
  // (depth 2) ahead of its own sibling `scripts/unpack.py` (depth 1) —
  // `unpack.py` rendered outdented beneath the whole `templates/` folder,
  // reading as orphaned. `compareSegments` fixes this: a file sorts before
  // its own directory's subdirectories, regardless of alphabetical value.
  test('sorts a three-depth tree so each directory groups its own files before its subdirectories', () => {
    const realDir = '.kortix/opencode/skills/docx';
    const paths = [
      `${realDir}/CREATION.md`,
      `${realDir}/EDITING.md`,
      `${realDir}/SKILL.md`,
      `${realDir}/scripts/accept_changes.py`,
      `${realDir}/scripts/comment.py`,
      `${realDir}/scripts/pack.py`,
      `${realDir}/scripts/unpack.py`,
      `${realDir}/scripts/templates/comments.xml`,
      `${realDir}/scripts/templates/commentsExtended.xml`,
      `${realDir}/scripts/templates/commentsExtensible.xml`,
      `${realDir}/scripts/templates/commentsIds.xml`,
      `${realDir}/scripts/templates/people.xml`,
    ];
    const tree = buildFileTree(paths, realDir);

    expect(tree).toHaveLength(12);
    expect(tree[0]).toMatchObject({ name: 'SKILL.md', depth: 0 });
    expect(tree.map((n) => n.path)).toEqual([
      `${realDir}/SKILL.md`,
      `${realDir}/CREATION.md`,
      `${realDir}/EDITING.md`,
      `${realDir}/scripts/accept_changes.py`,
      `${realDir}/scripts/comment.py`,
      `${realDir}/scripts/pack.py`,
      `${realDir}/scripts/unpack.py`,
      `${realDir}/scripts/templates/comments.xml`,
      `${realDir}/scripts/templates/commentsExtended.xml`,
      `${realDir}/scripts/templates/commentsExtensible.xml`,
      `${realDir}/scripts/templates/commentsIds.xml`,
      `${realDir}/scripts/templates/people.xml`,
    ]);
    // `scripts/unpack.py` (depth 1) now sorts before `scripts/templates/*`
    // (depth 2) — it is a file sibling of accept_changes/comment/pack, listed
    // with them, ahead of the `templates/` subdirectory.
    expect(tree.map((n) => n.depth)).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    expect(tree.every((n) => n.path.startsWith(`${realDir}/`))).toBe(true);
  });
});

describe('isMarkdownPath', () => {
  test('.md and .markdown files are markdown', () => {
    expect(isMarkdownPath('.kortix/opencode/skills/docx/SKILL.md')).toBe(true);
    expect(isMarkdownPath('README.markdown')).toBe(true);
  });
  test('everything else is not', () => {
    expect(isMarkdownPath('scripts/pack.py')).toBe(false);
    expect(isMarkdownPath('scripts/templates/comments.xml')).toBe(false);
  });
});

describe('languageForPath', () => {
  test('maps known extensions to a shiki language id', () => {
    expect(languageForPath('scripts/accept_changes.py')).toBe('python');
    expect(languageForPath('scripts/templates/comments.xml')).toBe('xml');
  });
  test('an unknown extension falls back to plain text, not a crash', () => {
    expect(languageForPath('data.someweirdext')).toBe('text');
  });
  test('a file with no extension falls back to plain text', () => {
    expect(languageForPath('Makefile')).toBe('text');
  });
});
