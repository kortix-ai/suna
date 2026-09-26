/**
 * Port of apps/web `tool/tools/apply-patch-tool.test.tsx` over the pure logic
 * the mobile `ApplyPatchTool` renders from.
 */
import { describe, expect, test } from 'bun:test';
import {
  PATCH_TEXT,
  patchBodyKind,
  patchFiles,
  patchInitialExpanded,
  patchRow,
  patchTrigger,
  toneBadgeSpec,
} from './files-patch';

const ADDS = [
  { relativePath: 'random-aurora.txt', type: 'add', additions: 1 },
  { relativePath: 'random-cactus.txt', type: 'add', additions: 1 },
  { relativePath: 'random-orbit.txt', type: 'add', additions: 1 },
  { relativePath: 'random-pixel.txt', type: 'add', additions: 1 },
] as const;

const settled = (files: readonly unknown[], isError = false) =>
  patchTrigger({ files: patchFiles(files), status: 'completed', running: false, isError });

describe('ApplyPatchTool trigger', () => {
  test('says what happened, not which mechanism did it', () => {
    const t = settled(ADDS);
    expect(t).toMatchObject({ preparing: false, title: 'Wrote', subtitle: '4 files', icon: 'create' });
  });

  test('one file names itself', () => {
    expect(settled([ADDS[0]])).toMatchObject({ title: 'Wrote', subtitle: 'random-aurora.txt' });
  });

  test('a mixed patch claims no shape it does not have', () => {
    const t = settled([ADDS[0], { relativePath: 'gone.ts', type: 'delete', deletions: 3 }]);
    expect(t).toMatchObject({ title: 'Changed', subtitle: '2 files', icon: 'edit' });
  });

  test('an edit reads as an edit', () => {
    expect(settled([{ relativePath: 'a.ts', type: 'update', additions: 2 }])).toMatchObject({
      title: 'Edited',
      subtitle: 'a.ts',
    });
  });

  test('a delete leads with the delete glyph', () => {
    expect(settled([{ relativePath: 'gone.ts', type: 'delete' }])).toMatchObject({ title: 'Deleted', icon: 'delete' });
  });

  test('a settled patch with no file list carries no subtitle', () => {
    expect(settled([])).toMatchObject({ preparing: false, title: 'Changed', subtitle: undefined });
  });
});

describe('ApplyPatchTool, when the patch did not land', () => {
  test('a failed patch does not wear the wording of one that succeeded', () => {
    const t = settled(ADDS, true);
    expect(t.title).toBe("Couldn't write");
    expect(patchBodyKind({ isError: true, files: patchFiles(ADDS) })).toBe('error');
  });
});

describe('ApplyPatchTool while the patch is still streaming', () => {
  test('the live line is the ROW, not a body under it', () => {
    const t = patchTrigger({ files: [], status: 'running', running: true, isError: false });
    expect(t.preparing).toBe(true);
    expect(PATCH_TEXT.preparingChanges).toBe('Preparing changes…');
  });

  test('a row with nothing to open is not a door', () => {
    expect(patchBodyKind({ isError: false, files: [] })).toBeNull();
  });

  test('once files arrive the row names them and opens', () => {
    const files = patchFiles([{ relativePath: 'a/b.ts', type: 'update', additions: 2 }]);
    const t = patchTrigger({ files, status: 'running', running: true, isError: false });
    expect(t).toMatchObject({ preparing: false, title: 'Editing', subtitle: 'b.ts' });
    expect(patchBodyKind({ isError: false, files })).toBe('files');
  });

  test('a running part outside a live turn is settled wording, not preparing', () => {
    expect(patchTrigger({ files: [], status: 'running', running: false, isError: false }).preparing).toBe(false);
  });
});

describe('patchFiles / patchRow', () => {
  test('non-array metadata is no files', () => {
    expect(patchFiles(undefined)).toEqual([]);
    expect(patchFiles({})).toEqual([]);
  });

  test('a single file starts expanded, several start closed', () => {
    expect(patchInitialExpanded(patchFiles([ADDS[0]]))).toBe(0);
    expect(patchInitialExpanded(patchFiles(ADDS))).toBeNull();
  });

  test('a row names the file, its directory, and falls back to update', () => {
    expect(patchRow({ relativePath: 'src/lib/a.ts', additions: 1 })).toMatchObject({
      relPath: 'src/lib/a.ts',
      name: 'a.ts',
      dir: 'src/lib',
      typeKey: 'update',
      diff: null,
      hasDiff: false,
    });
  });

  test('before/after → inline diff; patch or diff → raw patch view', () => {
    expect(patchRow({ filePath: '/w/a.ts', before: 'a', after: 'b' }).diff).toEqual({
      kind: 'inline',
      before: 'a',
      after: 'b',
    });
    expect(patchRow({ filePath: '/w/a.ts', patch: '@@ -1 +1 @@' }).diff).toEqual({ kind: 'patch', patch: '@@ -1 +1 @@' });
    expect(patchRow({ filePath: '/w/a.ts', diff: 'd' }).diff).toEqual({ kind: 'patch', patch: 'd' });
  });

  test('only one side of before/after still opens, but draws no diff (web parity)', () => {
    const row = patchRow({ filePath: '/w/a.ts', before: 'a' });
    expect(row.hasDiff).toBe(true);
    expect(row.diff).toBeNull();
  });
});

describe('toneBadgeSpec — web Badge tone variants on mobile tokens', () => {
  test('success / warning / destructive paint their own tone on a 10% fill of it', () => {
    expect(toneBadgeSpec('success')).toEqual({ text: 'success', fill: 'success', fillAlpha: 0.1 });
    expect(toneBadgeSpec('warning')).toEqual({ text: 'warning', fill: 'warning', fillAlpha: 0.1 });
    expect(toneBadgeSpec('destructive')).toEqual({ text: 'destructive', fill: 'destructive', fillAlpha: 0.1 });
  });

  test('info is neutral: muted-foreground on its 10% fill', () => {
    expect(toneBadgeSpec('info')).toEqual({ text: 'mutedForeground', fill: 'mutedForeground', fillAlpha: 0.1 });
  });

  test('muted is bg-muted/50 with muted-foreground text', () => {
    expect(toneBadgeSpec('muted')).toEqual({ text: 'mutedForeground', fill: 'muted', fillAlpha: 0.5 });
  });
});
