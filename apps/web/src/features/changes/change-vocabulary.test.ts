import { describe, expect, test } from 'bun:test';

import {
  CHANGE_KIND,
  DIFF_LAYOUT_LABEL,
  PROPOSED_CHANGE_STATE,
  changeKind,
  diffViewportClass,
  entryFromCommitFile,
  entryFromVcsFile,
  fileCount,
  initiallyExpanded,
  proposedChangeTimeline,
  shouldReseedExpansion,
  splitPath,
  splitUnifiedPatch,
  totalChanges,
  type ChangeEntry,
} from './change-vocabulary';

const entry = (over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  path: 'src/app/page.tsx',
  kind: 'modified',
  additions: 3,
  deletions: 1,
  ...over,
});

describe('change vocabulary — no git words reach a screen', () => {
  test('every label is a plain word, never git status shorthand', () => {
    const labels = Object.values(CHANGE_KIND).map((m) => m.label);
    expect(labels).not.toContain('Modified');
    expect(labels).not.toContain('Deleted');
    expect(new Set(labels)).toEqual(new Set(['Added', 'Edited', 'Removed', 'Renamed', 'Copied']));
  });

  test('modified reads as Edited and deleted as Removed', () => {
    expect(changeKind('modified').label).toBe('Edited');
    expect(changeKind('deleted').label).toBe('Removed');
    expect(changeKind('added').label).toBe('Added');
  });

  test('a typechange is an edit, not a fourth word to learn', () => {
    expect(changeKind('typechange').label).toBe('Edited');
    expect(changeKind('typechange').tone).toBe('warning');
  });

  test('an unknown or missing status falls back to Edited, never blank', () => {
    expect(changeKind(undefined).label).toBe('Edited');
    expect(changeKind(null).label).toBe('Edited');
    expect(changeKind('quantum-entangled').label).toBe('Edited');
  });

  test('tones follow the Kortix status palette', () => {
    expect(changeKind('added').tone).toBe('success');
    expect(changeKind('deleted').tone).toBe('destructive');
  });

  test('a stacked diff collapses to its container earlier than a side-by-side one', () => {
    // Two code columns need roughly 860px; one needs roughly 680px. Below that
    // the diff scrolls sideways instead of wrapping into unreadable ribbons.
    expect(diffViewportClass('split')).toBe('min-w-[860px] lg:min-w-0');
    expect(diffViewportClass('split')).not.toContain('sm:min-w-0');
    expect(diffViewportClass('unified')).toBe('min-w-[680px] sm:min-w-0');
  });

  test('diff layouts are described by shape, not by diff-tool jargon', () => {
    expect(DIFF_LAYOUT_LABEL.unified).toBe('Stacked');
    expect(DIFF_LAYOUT_LABEL.split).toBe('Side by side');
    expect(Object.values(DIFF_LAYOUT_LABEL)).not.toContain('Unified');
    expect(Object.values(DIFF_LAYOUT_LABEL)).not.toContain('Split');
  });

  test('an open proposal names the reader as the next move', () => {
    expect(PROPOSED_CHANGE_STATE.open.label).toBe('Waiting on you');
    expect(PROPOSED_CHANGE_STATE.merged.label).toBe('Applied');
    expect(PROPOSED_CHANGE_STATE.closed.label).toBe('Dismissed');
  });

  test('no state label uses merge/close/PR language', () => {
    const labels = Object.values(PROPOSED_CHANGE_STATE).map((s) => s.label.toLowerCase());
    for (const banned of ['merge', 'merged', 'closed', 'pull request']) {
      expect(labels).not.toContain(banned);
    }
  });
});

describe('normalising the two API shapes', () => {
  test('a change-request file keeps its rename origin', () => {
    const e = entryFromCommitFile(
      { path: 'b.ts', old_path: 'a.ts', status: 'renamed', additions: 0, deletions: 0 },
      'PATCH',
    );
    expect(e).toEqual({
      path: 'b.ts',
      kind: 'renamed',
      additions: 0,
      deletions: 0,
      fromPath: 'a.ts',
      patch: 'PATCH',
    });
  });

  test('a live session file maps `file` onto `path` and carries its own patch', () => {
    const e = entryFromVcsFile({
      file: 'x.ts',
      status: 'added',
      patch: 'P',
      additions: 9,
      deletions: 0,
    });
    expect(e.path).toBe('x.ts');
    expect(e.kind).toBe('added');
    expect(e.patch).toBe('P');
  });

  test('a live session file with no status still renders as an edit', () => {
    expect(
      changeKind(entryFromVcsFile({ file: 'x.ts', additions: 1, deletions: 1 }).kind).label,
    ).toBe('Edited');
  });
});

describe('reading a path', () => {
  test('splits a nested path into name and folder', () => {
    expect(splitPath('src/app/page.tsx')).toEqual({ name: 'page.tsx', dir: 'src/app' });
  });

  test('a root-level file has no folder', () => {
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });

  test('a trailing slash does not produce an empty name', () => {
    expect(splitPath('src/app/')).toEqual({ name: 'app', dir: 'src' });
  });

  test('a dotfile is a name, not a folder', () => {
    expect(splitPath('.gitignore')).toEqual({ name: '.gitignore', dir: '' });
  });
});

describe('counting', () => {
  test('sums additions and deletions across files', () => {
    expect(totalChanges([entry(), entry({ additions: 10, deletions: 4 })])).toEqual({
      files: 2,
      additions: 13,
      deletions: 5,
    });
  });

  test('an empty change counts to zero rather than throwing', () => {
    expect(totalChanges([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  test('one file is singular', () => {
    expect(fileCount(1)).toBe('1 file');
    expect(fileCount(0)).toBe('0 files');
    expect(fileCount(12)).toBe('12 files');
  });
});

describe('the proposal timeline', () => {
  const rel = (iso: string) => `after ${iso}`;

  test('an applied proposal reports when it was applied', () => {
    expect(
      proposedChangeTimeline(
        { status: 'merged', created_at: 'C', merged_at: 'M', closed_at: null },
        rel,
      ),
    ).toBe('Applied after M');
  });

  test('a dismissed proposal reports when it was dismissed', () => {
    expect(proposedChangeTimeline({ status: 'closed', created_at: 'C', closed_at: 'X' }, rel)).toBe(
      'Dismissed after X',
    );
  });

  test('an open proposal reports when it was proposed', () => {
    expect(proposedChangeTimeline({ status: 'open', created_at: 'C' }, rel)).toBe(
      'Proposed after C',
    );
  });

  test('a merged proposal with no timestamp falls back to when it was proposed', () => {
    expect(
      proposedChangeTimeline({ status: 'merged', created_at: 'C', merged_at: null }, rel),
    ).toBe('Proposed after C');
  });
});

describe('splitting a whole-change patch', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n');

  test('keys each chunk by the file the change list reports', () => {
    const byPath = splitUnifiedPatch(patch);
    expect([...byPath.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('each chunk keeps its own diff header so the renderer can read it', () => {
    const byPath = splitUnifiedPatch(patch);
    expect(byPath.get('src/a.ts')).toStartWith('diff --git a/src/a.ts b/src/a.ts');
    expect(byPath.get('src/a.ts')).toContain('+new');
    expect(byPath.get('src/a.ts')).not.toContain('+hello');
  });

  test('a rename keys by the new path, which is what the file list carries', () => {
    const renamed = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\n';
    expect([...splitUnifiedPatch(renamed).keys()]).toEqual(['new.ts']);
  });

  test('an empty or whitespace patch yields no chunks instead of one blank chunk', () => {
    expect(splitUnifiedPatch('').size).toBe(0);
    expect(splitUnifiedPatch('   \n  ').size).toBe(0);
  });

  // The file list comes from `git diff --name-status -z`, which reports raw
  // (unquoted) paths. The patch headers do not: git C-quotes non-ASCII paths
  // (octal UTF-8 bytes) and leaves paths containing " b/" ambiguous. A chunk
  // whose header cannot be read back into the file-list path renders as an
  // accordion with no body — the review-page blank-body bug.
  describe('paths git quotes or makes ambiguous', () => {
    /** The quoted-octal form git writes for a non-ASCII path (core.quotepath). */
    const quoted = (path: string) => {
      const bytes = Buffer.from(path, 'utf8');
      let out = '';
      for (const b of bytes) {
        if (b > 0x7e || b < 0x20) out += `\\${b.toString(8).padStart(3, '0')}`;
        else out += String.fromCharCode(b);
      }
      return out;
    };

    test('a non-ASCII path keys by its raw name even though git quoted the header', () => {
      const name = '日本語-ファイル.txt';
      const q = quoted(name);
      const patch = [
        `diff --git "a/${q}" "b/${q}"`,
        'index 111..222 100644',
        `--- "a/${q}"\t`,
        `+++ "b/${q}"\t`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');
      expect([...splitUnifiedPatch(patch).keys()]).toEqual([name]);
    });

    test('a path containing " b/" keys by the full new path from the +++ line', () => {
      const patch = [
        'diff --git a/x b/deep.txt b/x b/deep.txt',
        'index 111..222 100644',
        '--- a/x b/deep.txt\t',
        '+++ b/x b/deep.txt\t',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');
      expect([...splitUnifiedPatch(patch).keys()]).toEqual(['x b/deep.txt']);
    });

    test('a renamed file with spaces and non-ascii keys by the new path', () => {
      const name = 'новая папка/файл с пробелом.txt';
      const q = quoted(name);
      const patch = [
        `diff --git "a/stara/${q}" "b/${q}"`,
        'similarity index 87%',
        'rename from stara/стар файл.txt',
        `rename to "${q}"`,
        `--- "a/stara/${q}"`,
        `+++ "b/${q}"`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');
      expect([...splitUnifiedPatch(patch).keys()]).toEqual([name]);
    });

    test('a deletion keys by the deleted path via the header (+++ is /dev/null)', () => {
      const patch = [
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ].join('\n');
      expect([...splitUnifiedPatch(patch).keys()]).toEqual(['src/gone.ts']);
    });

    test('a pure rename (no hunks, no +++ line) keys by the new path', () => {
      const renamed = [
        'diff --git a/plan.md b/plans/plan.md',
        'similarity index 100%',
        'rename from plan.md',
        'rename to plans/plan.md',
      ].join('\n');
      expect([...splitUnifiedPatch(renamed).keys()]).toEqual(['plans/plan.md']);
    });

    // The renderer's own parser (@pierre/diffs) only understands the unquoted
    // `--- a/…` / `+++ b/…` / `diff --git a/… b/…` forms: a quoted header both
    // crashes its parser and shows git's octal escapes as the file name. The
    // chunks handed to it must carry the decoded paths instead.
    test('a quoted header is rewritten to decoded paths in the rendered chunk', () => {
      const name = '日本語-ファイル.txt';
      const q = quoted(name);
      const patch = [
        `diff --git "a/${q}" "b/${q}"`,
        'index 111..222 100644',
        `--- "a/${q}"`,
        `+++ "b/${q}"`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');
      const chunk = splitUnifiedPatch(patch).get(name);
      expect(chunk).toContain(`diff --git a/${name} b/${name}`);
      expect(chunk).toContain(`--- a/${name}`);
      expect(chunk).toContain(`+++ b/${name}`);
      expect(chunk).not.toContain('"a/');
      expect(chunk).not.toContain('"b/');
    });

    test('a quoted tab-suffixed header is rewritten the same way', () => {
      const name = 'отчёт.csv';
      const q = quoted(name);
      const patch = [
        `diff --git "a/${q}" "b/${q}"`,
        'new file mode 100644',
        `--- "a/${q}"\t`,
        `+++ "b/${q}"\t`,
        '@@ -0,0 +1 @@',
        '+v',
      ].join('\n');
      const chunk = splitUnifiedPatch(patch).get(name);
      expect(chunk).toContain(`+++ b/${name}`);
      expect(chunk).not.toContain('"b/');
    });

    test('unquoted chunks pass through untouched', () => {
      const byPath = splitUnifiedPatch(patch);
      expect(byPath.get('src/a.ts')).toStartWith('diff --git a/src/a.ts b/src/a.ts');
    });
  });
});

describe('which rows start open', () => {
  test('the first file opens so a one-file change needs no clicks', () => {
    expect([...initiallyExpanded([entry({ path: 'a' }), entry({ path: 'b' })])]).toEqual(['a']);
  });

  test('the rest stay closed so a thirty-file change is not a wall of diff', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry({ path: `f${i}` }));
    expect(initiallyExpanded(many).size).toBe(1);
  });

  test('an empty change opens nothing', () => {
    expect(initiallyExpanded([]).size).toBe(0);
  });
});

describe('re-seeding expansion when the dialog is reused', () => {
  test("seeds once the first change request's files arrive", () => {
    expect(shouldReseedExpansion(null, 'cr-a', 3)).toBe(true);
  });

  test('does not seed while the diff is still loading', () => {
    expect(shouldReseedExpansion(null, 'cr-a', 0)).toBe(false);
  });

  test('does not re-seed on every render of the same change request', () => {
    expect(shouldReseedExpansion('cr-a', 'cr-a', 3)).toBe(false);
  });

  test('re-seeds when the reader switches to another change request', () => {
    expect(shouldReseedExpansion('cr-a', 'cr-b', 5)).toBe(true);
  });

  test('a keyless surface seeds exactly once and never loops', () => {
    expect(shouldReseedExpansion(null, '', 2)).toBe(true);
    expect(shouldReseedExpansion('', '', 2)).toBe(false);
    // A file the agent writes mid-session grows the list; it must not re-seed,
    // or the row being read would collapse under the reader.
    expect(shouldReseedExpansion('', '', 9)).toBe(false);
  });
});
