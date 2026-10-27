import { describe, expect, test } from 'bun:test';

import { splitablePatch } from './diff-view';

/**
 * The layout toggle's contract against Pierre: a one-sided diff (a new file:
 * only `+` lines; a deleted file: only `−` lines) must render a SPLIT layout
 * with an empty counterpart column, not collapse to the same single column
 * both layouts show. Pierre excludes the empty side when it parses the file
 * as `new`/`deleted` — which it reads from the `new file mode` /
 * `deleted file mode` header line — so the patch handed to Pierre loses only
 * that metadata line. See `diff-view.tsx` for the full why.
 */
const NEW_FILE = [
  'diff --git a/src/new-file.ts b/src/new-file.ts',
  'new file mode 100644',
  'index 0000000..e69de29',
  '--- /dev/null',
  '+++ b/src/new-file.ts',
  '@@ -0,0 +1,3 @@',
  '+const a = 1;',
  '+const b = 2;',
  '+const c = 3;',
].join('\n');

const DELETED_FILE = [
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index e69de29..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-const a = 1;',
  '-const b = 2;',
  '-const c = 3;',
].join('\n');

const MIXED = [
  'diff --git a/src/app/page.tsx b/src/app/page.tsx',
  'index 1111111..2222222 100644',
  '--- a/src/app/page.tsx',
  '+++ b/src/app/page.tsx',
  '@@ -1,3 +1,4 @@',
  ' const one = 1;',
  '-const two = 2;',
  '+const two = 22;',
  '+const three = 3;',
].join('\n');

describe('splitablePatch', () => {
  test('a new-file patch keeps every hunk byte and loses only the mode line', () => {
    const out = splitablePatch(NEW_FILE);
    expect(out).not.toContain('new file mode');
    expect(out).toContain('--- /dev/null');
    expect(out).toContain('+++ b/src/new-file.ts');
    expect(out).toContain('@@ -0,0 +1,3 @@');
    expect(out).toContain('+const a = 1;');
    expect(out).toContain('+const c = 3;');
  });

  test('a deleted-file patch keeps every hunk byte and loses only the mode line', () => {
    const out = splitablePatch(DELETED_FILE);
    expect(out).not.toContain('deleted file mode');
    expect(out).toContain('--- a/src/gone.ts');
    expect(out).toContain('+++ /dev/null');
    expect(out).toContain('@@ -1,3 +0,0 @@');
    expect(out).toContain('-const c = 3;');
  });

  test('a mixed patch passes through byte-identical', () => {
    expect(splitablePatch(MIXED)).toBe(MIXED);
  });

  test('an already-normalized patch is stable (idempotent)', () => {
    expect(splitablePatch(splitablePatch(NEW_FILE))).toBe(splitablePatch(NEW_FILE));
  });

  test('a content line that mentions the metadata is never touched', () => {
    const patch = `${MIXED}\n+new file mode 100644 in docs\n-new file mode 100644 in docs`;
    const out = splitablePatch(patch);
    expect(out).toContain('+new file mode 100644 in docs');
    expect(out).toContain('-new file mode 100644 in docs');
    expect(out).toBe(patch);
  });

  test('an empty patch stays empty', () => {
    expect(splitablePatch('')).toBe('');
  });
});
