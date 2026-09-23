import { describe, expect, test } from 'bun:test';
import {
  changedFilesLabel,
  isOpenThreadSession,
  openChangeRequestPrefill,
  patchForFile,
  sessionActionRows,
  splitChangePath,
  summarizeSessionChanges,
  type SessionActionRowsInput,
} from './session-actions';

describe('summarizeSessionChanges', () => {
  test('non-array bodies are no changes', () => {
    for (const raw of [undefined, null, {}, 'x', 3]) {
      expect(summarizeSessionChanges(raw)).toEqual({ files: [], count: 0, additions: 0, deletions: 0 });
    }
  });

  test('sorts by path, totals the counts, splits name and dir', () => {
    const summary = summarizeSessionChanges([
      { file: 'src/b.ts', additions: 3, deletions: 1, status: 'modified', patch: 'p1' },
      { file: 'README.md', additions: 10, deletions: 0, status: 'added' },
    ]);
    expect(summary.count).toBe(2);
    expect(summary.additions).toBe(13);
    expect(summary.deletions).toBe(1);
    expect(summary.files.map((f) => f.path)).toEqual(['README.md', 'src/b.ts']);
    expect(summary.files[0]).toMatchObject({ name: 'README.md', dir: '', status: 'added', patch: '' });
    expect(summary.files[1]).toMatchObject({ name: 'b.ts', dir: 'src', status: 'modified', patch: 'p1' });
  });

  test('drops entries without a path and keeps the first of a duplicate path', () => {
    const summary = summarizeSessionChanges([
      { file: '', additions: 1, deletions: 0 },
      { additions: 1, deletions: 0 },
      null,
      { file: 'a.ts', additions: 1, deletions: 0, status: 'added' },
      { file: 'a.ts', additions: 9, deletions: 9, status: 'deleted' },
    ]);
    expect(summary.count).toBe(1);
    expect(summary.files[0]).toMatchObject({ path: 'a.ts', additions: 1, status: 'added' });
  });

  test('an unknown status reads as modified; bad counts read as 0', () => {
    const summary = summarizeSessionChanges([
      { file: 'x.ts', additions: -2, deletions: Number.NaN, status: 'renamed' },
    ]);
    expect(summary.files[0]).toMatchObject({ status: 'modified', additions: 0, deletions: 0 });
  });
});

describe('splitChangePath', () => {
  test('nested, root, and trailing-slash paths', () => {
    expect(splitChangePath('src/app/page.tsx')).toEqual({ name: 'page.tsx', dir: 'src/app' });
    expect(splitChangePath('package.json')).toEqual({ name: 'package.json', dir: '' });
    expect(splitChangePath('dir/')).toEqual({ name: 'dir/', dir: 'dir' });
  });
});

describe('changedFilesLabel', () => {
  test('singular and plural', () => {
    expect(changedFilesLabel(1)).toBe('1 file');
    expect(changedFilesLabel(4)).toBe('4 files');
  });
});

describe('patchForFile', () => {
  test('an empty patch stays empty', () => {
    expect(patchForFile({ path: 'a.png', patch: '' })).toBe('');
    expect(patchForFile({ path: 'a.png', patch: '  \n' })).toBe('');
  });

  test('a git patch is unchanged', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    expect(patchForFile({ path: 'a.ts', patch })).toBe(patch);
  });

  test('a headerless patch gets a git header for its path', () => {
    const patch = 'Index: a.ts\n===\n--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    expect(patchForFile({ path: 'src/a.ts', patch })).toBe(`diff --git a/src/a.ts b/src/a.ts\n${patch}`);
  });
});

describe('isOpenThreadSession', () => {
  const session = { session_id: 'k-1', opencode_session_id: 'oc-1' };
  test('matches either id', () => {
    expect(isOpenThreadSession(session, 'oc-1')).toBe(true);
    expect(isOpenThreadSession(session, 'k-1')).toBe(true);
  });
  test('no thread or another thread', () => {
    expect(isOpenThreadSession(session, null)).toBe(false);
    expect(isOpenThreadSession(session, 'oc-2')).toBe(false);
    expect(isOpenThreadSession({ session_id: 'k-1', opencode_session_id: null }, 'oc-1')).toBe(false);
  });
});

describe('openChangeRequestPrefill', () => {
  test('branch into base, with the session title', () => {
    expect(openChangeRequestPrefill({ branch_name: 'b-1', base_ref: 'main' }, ' Fix login ')).toEqual({
      headRef: 'b-1',
      baseRef: 'main',
      title: 'Fix login',
    });
  });
  test('no branch, or a branch equal to its base, has nothing to propose', () => {
    expect(openChangeRequestPrefill({ branch_name: '', base_ref: 'main' }, 't')).toBeNull();
    expect(openChangeRequestPrefill({ branch_name: null, base_ref: 'main' }, 't')).toBeNull();
    expect(openChangeRequestPrefill({ branch_name: 'main', base_ref: 'main' }, 't')).toBeNull();
  });
  test('a missing base still prefills the branch (the sheet defaults the base)', () => {
    expect(openChangeRequestPrefill({ branch_name: 'b-1', base_ref: undefined }, 't')).toEqual({
      headRef: 'b-1',
      baseRef: '',
      title: 't',
    });
  });
});

describe('sessionActionRows', () => {
  const base: SessionActionRowsInput = {
    isOpenThread: true,
    hasRuntime: true,
    canManageLifecycle: true,
    hasBranch: true,
    changes: { pending: false, error: false, count: 3 },
    busy: false,
    compacting: false,
  };

  test('open thread, idle, with changes: all three rows enabled', () => {
    const rows = sessionActionRows(base);
    expect(rows.openChangeRequest).toEqual({ visible: true, enabled: true });
    expect(rows.viewChanges).toEqual({ visible: true, enabled: true, value: '3 files' });
    expect(rows.compact).toEqual({ visible: true, enabled: true });
  });

  test('no changes disables View changes with "No changes"', () => {
    const rows = sessionActionRows({ ...base, changes: { pending: false, error: false, count: 0 } });
    expect(rows.viewChanges).toEqual({ visible: true, enabled: false, value: 'No changes' });
  });

  test('a loading or failed read keeps View changes enabled, with no count', () => {
    expect(sessionActionRows({ ...base, changes: { pending: true, error: false, count: 0 } }).viewChanges).toEqual({
      visible: true,
      enabled: true,
    });
    expect(sessionActionRows({ ...base, changes: { pending: false, error: true, count: 0 } }).viewChanges).toEqual({
      visible: true,
      enabled: true,
    });
  });

  test('busy disables Compact; compacting wins over busy', () => {
    expect(sessionActionRows({ ...base, busy: true }).compact).toEqual({
      visible: true,
      enabled: false,
      value: 'Working',
    });
    expect(sessionActionRows({ ...base, busy: true, compacting: true }).compact).toEqual({
      visible: true,
      enabled: false,
      value: 'Compacting…',
    });
  });

  test('another session (drawer long press): only Open change request', () => {
    const rows = sessionActionRows({ ...base, isOpenThread: false });
    expect(rows.openChangeRequest.visible).toBe(true);
    expect(rows.viewChanges.visible).toBe(false);
    expect(rows.compact.visible).toBe(false);
  });

  test('no runtime hides the runtime rows', () => {
    const rows = sessionActionRows({ ...base, hasRuntime: false });
    expect(rows.viewChanges.visible).toBe(false);
    expect(rows.compact.visible).toBe(false);
  });

  test('no lifecycle right hides Compact only', () => {
    const rows = sessionActionRows({ ...base, canManageLifecycle: false });
    expect(rows.compact.visible).toBe(false);
    expect(rows.viewChanges.visible).toBe(true);
  });

  test('no branch hides Open change request', () => {
    expect(sessionActionRows({ ...base, hasBranch: false }).openChangeRequest.visible).toBe(false);
  });
});
