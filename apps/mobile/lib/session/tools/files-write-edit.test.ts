/**
 * Port of apps/web `tool/tools/write-tool.test.tsx` and `edit-tool.test.tsx`
 * over the pure logic the mobile `WriteTool` / `EditTool` render from.
 */
import { describe, expect, test } from 'bun:test';
import {
  FILE_BODY_TEXT,
  editBodyKind,
  editSources,
  editStat,
  fileRowTitle,
  isStalePendingFile,
  lineDiffCounts,
  writeBodyKind,
  writeStat,
  writeTriggerStat,
} from './files-write-edit';

describe('writeStat — the count a closed row reports', () => {
  test('content counts as pure additions — nothing client-side knows the old file', () => {
    expect(writeStat('a\nb\nc')).toEqual({ additions: 3, deletions: 0 });
  });

  test('no content, no stat — the row must not claim an empty write', () => {
    expect(writeStat('')).toBeUndefined();
  });

  test('a trailing newline is a line boundary, same as split() counted it', () => {
    expect(writeStat('a\n')).toEqual({ additions: 2, deletions: 0 });
  });
});

describe('WriteTool trigger carries the filename and the size', () => {
  test('a settled write shows the stat without being expanded', () => {
    expect(writeTriggerStat({ isError: false, content: 'a\nb\nc' })).toEqual({ additions: 3, deletions: 0 });
  });

  test('a STREAMING write already counts — the number climbs with the content', () => {
    expect(writeTriggerStat({ isError: false, content: 'a\nb' })).toEqual({ additions: 2, deletions: 0 });
  });

  test('a failed write carries no stat', () => {
    expect(writeTriggerStat({ isError: true, content: 'a\nb' })).toBeUndefined();
  });

  test('the expanded row renders the written content itself', () => {
    expect(writeBodyKind({ isError: false, content: 'hello world', isStalePending: false })).toBe('code');
  });
});

describe('WriteTool speaks the tense the row is actually in', () => {
  test('a live call is present tense', () => {
    expect(fileRowTitle('write', { running: true, isError: false })).toBe('Writing');
  });

  test('a settled call is past tense', () => {
    expect(fileRowTitle('write', { running: false, isError: false })).toBe('Wrote');
  });

  test('a failed write never claims it wrote', () => {
    expect(fileRowTitle('write', { running: false, isError: true })).toBe("Couldn't write");
    expect(writeBodyKind({ isError: true, content: 'a', isStalePending: false })).toBe('error');
  });
});

describe('WriteTool, for the part that never got its content', () => {
  test('a stale pending part states the fact instead of shimmering forever', () => {
    const stale = isStalePendingFile({ running: false, filename: '', status: 'running' });
    expect(stale).toBe(true);
    expect(writeBodyKind({ isError: false, content: '', isStalePending: stale })).toBe('stale');
    expect(FILE_BODY_TEXT.noContentReceived).toBe('No content received');
  });

  test('and it carries no stat — there is nothing to count', () => {
    expect(writeTriggerStat({ isError: false, content: '' })).toBeUndefined();
  });

  test('a live pending part is not stale', () => {
    expect(isStalePendingFile({ running: true, filename: '', status: 'pending' })).toBe(false);
    expect(isStalePendingFile({ running: false, filename: 'a.ts', status: 'pending' })).toBe(false);
    expect(isStalePendingFile({ running: false, filename: '', status: 'completed' })).toBe(false);
  });
});

describe('lineDiffCounts — jsdiff diffLines semantics', () => {
  test("'b' replaced by 'x\\ny': one line out, two in", () => {
    expect(lineDiffCounts('a\nb\nc', 'a\nx\ny\nc')).toEqual({ additions: 2, deletions: 1 });
  });

  test('an all-additions edit carries no deletion', () => {
    expect(lineDiffCounts('a\n', 'a\nb\nc\n')).toEqual({ additions: 2, deletions: 0 });
  });

  test('identical before/after counts nothing', () => {
    expect(lineDiffCounts('a\nb', 'a\nb')).toEqual({ additions: 0, deletions: 0 });
  });

  test('a line keeps its newline: `a` and `a\\n` are different lines, as jsdiff tokenizes', () => {
    expect(lineDiffCounts('a', 'a\nb')).toEqual({ additions: 2, deletions: 1 });
  });

  test('empty sides count every line of the other', () => {
    expect(lineDiffCounts('', 'x\ny')).toEqual({ additions: 2, deletions: 0 });
    expect(lineDiffCounts('x\ny', '')).toEqual({ additions: 0, deletions: 2 });
  });

  test('bails (undefined) past maxEditLength, like jsdiff', () => {
    const before = Array.from({ length: 30 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 30 }, (_, i) => `new-${i}`).join('\n');
    expect(lineDiffCounts(before, after, 10)).toBeUndefined();
    expect(lineDiffCounts(before, after, 1000)).toEqual({ additions: 30, deletions: 30 });
  });
});

describe('EditTool trigger carries the line counts', () => {
  test('a settled edit reports +added −removed', () => {
    expect(editStat({ status: 'completed', hasDiff: true, before: 'a\nb\nc', after: 'a\nx\ny\nc' })).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  test('a RUNNING edit carries no stat — counting a half-arrived diff per chunk is per-frame work', () => {
    expect(editStat({ status: 'running', hasDiff: true, before: 'a', after: 'b' })).toBeUndefined();
  });

  test('no diff, no stat', () => {
    expect(editStat({ status: 'completed', hasDiff: false, before: '', after: '' })).toBeUndefined();
  });
});

describe('EditTool speaks the tense the row is actually in', () => {
  test('live → Editing, settled → Edited, failed → Couldn’t update', () => {
    expect(fileRowTitle('edit', { running: true, isError: false })).toBe('Editing');
    expect(fileRowTitle('edit', { running: false, isError: false })).toBe('Edited');
    expect(fileRowTitle('edit', { running: false, isError: true })).toBe("Couldn't update");
  });
});

describe('editSources — where the diff comes from', () => {
  test('metadata.filediff wins over the input strings', () => {
    const s = editSources(
      { filePath: '/w/a.ts', oldString: 'in-old', newString: 'in-new' },
      {},
      { filediff: { before: 'fd-old', after: 'fd-new' } },
    );
    expect(s).toMatchObject({ filePath: '/w/a.ts', before: 'fd-old', after: 'fd-new', hasDiff: true });
  });

  test('input, then streaming input; `target_filepath` names a morph edit file', () => {
    const s = editSources({}, { target_filepath: '/w/m.ts', code_edit: 'x', instructions: 'do it' }, {});
    expect(s).toMatchObject({ filePath: '/w/m.ts', codeEdit: 'x', morphInstructions: 'do it', hasDiff: false });
  });

  test('`??` semantics: an empty oldString is kept, not skipped', () => {
    const s = editSources({ oldString: '', newString: 'b' }, { oldString: 'stream-old' }, {});
    expect(s.before).toBe('');
    expect(s.after).toBe('b');
  });
});

describe('EditTool body', () => {
  test('error → fallback; diff → InlineDiffView; morph → code card; stale → no content', () => {
    expect(editBodyKind({ isError: true, hasDiff: true, codeEdit: '', isStalePending: false })).toBe('error');
    expect(editBodyKind({ isError: false, hasDiff: true, codeEdit: 'x', isStalePending: false })).toBe('diff');
    expect(editBodyKind({ isError: false, hasDiff: false, codeEdit: 'x', isStalePending: false })).toBe('morph');
    expect(editBodyKind({ isError: false, hasDiff: false, codeEdit: '', isStalePending: true })).toBe('stale');
    expect(editBodyKind({ isError: false, hasDiff: false, codeEdit: '', isStalePending: false })).toBe('none');
  });
});
