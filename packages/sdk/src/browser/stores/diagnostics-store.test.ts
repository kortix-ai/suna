import { beforeEach, describe, expect, test } from 'bun:test';
import { findDiagnosticsForFile, getRelativePath, useDiagnosticsStore } from './diagnostics-store';

describe('getRelativePath', () => {
  test('strips an absolute sandbox prefix up to the first project-root marker', () => {
    expect(getRelativePath('/workspace/repo/src/app/page.tsx')).toBe('src/app/page.tsx');
    expect(getRelativePath('file:///home/user/proj/internal/x.go')).toBe('internal/x.go');
    expect(getRelativePath('/workspace/repo/tests/a.test.ts')).toBe('tests/a.test.ts');
  });

  test('keeps the last three segments when no marker is present', () => {
    expect(getRelativePath('/workspace/a/b/c/d.ts')).toBe('b/c/d.ts');
    expect(getRelativePath('/workspace/d.ts')).toBe('workspace/d.ts');
  });

  test('returns a relative path unchanged', () => {
    expect(getRelativePath('src/a.ts')).toBe('src/a.ts');
  });
});

describe('setFromLspEvent → findDiagnosticsForFile', () => {
  beforeEach(() => useDiagnosticsStore.getState().clearAll());

  test('an LSP event is readable by absolute and by relative path', () => {
    useDiagnosticsStore.getState().setFromLspEvent({
      '/workspace/a.ts': [
        { range: { start: { line: 2, character: 4 } }, severity: 1, message: 'boom', source: 'ts' },
      ],
    });
    const { byFile } = useDiagnosticsStore.getState();

    const expected = [
      { file: '/workspace/a.ts', line: 2, column: 4, severity: 1, message: 'boom', source: 'ts' },
    ];
    expect(findDiagnosticsForFile(byFile, '/workspace/a.ts')).toMatchObject(expected);
    expect(findDiagnosticsForFile(byFile, 'a.ts')).toMatchObject(expected);
  });

  test('an empty list for a file removes its entry', () => {
    const { setFromLspEvent } = useDiagnosticsStore.getState();
    setFromLspEvent({ '/workspace/a.ts': [{ range: { start: { line: 0, character: 0 } }, message: 'x' }] });
    setFromLspEvent({ '/workspace/a.ts': [] });
    expect(findDiagnosticsForFile(useDiagnosticsStore.getState().byFile, '/workspace/a.ts')).toBeUndefined();
  });
});
