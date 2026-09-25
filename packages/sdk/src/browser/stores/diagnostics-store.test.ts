import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

describe('persistence through sessionStorage', () => {
  // Each case installs its own `window` and bare `sessionStorage` global. Put
  // the originals back so no mutation leaks into another case.
  const globals = globalThis as Record<string, unknown>;
  const ORIGINAL = {
    window: globals.window,
    localStorage: globals.localStorage,
    sessionStorage: globals.sessionStorage,
  };
  const PERSIST_KEY = 'kortix-diagnostics';

  beforeEach(() => useDiagnosticsStore.getState().clearAll());
  afterEach(() => {
    globals.window = ORIGINAL.window;
    globals.localStorage = ORIGINAL.localStorage;
    globals.sessionStorage = ORIGINAL.sessionStorage;
  });

  function mapStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  const diag = { line: 1, column: 0, severity: 1 as const, message: 'boom' };

  test('writes byFile to window.sessionStorage and reads it back on rehydrate', async () => {
    const storage = mapStorage();
    globals.window = { sessionStorage: storage };

    useDiagnosticsStore.getState().setFileDiagnostics('/workspace/a.ts', [{ file: '/workspace/a.ts', ...diag }]);
    const written = storage.map.get(PERSIST_KEY);
    expect(written).toBeDefined();
    expect(JSON.parse(written!).state.byFile['/workspace/a.ts']).toMatchObject([{ message: 'boom' }]);

    // setState persists too, so put the saved value back before rehydrating.
    useDiagnosticsStore.setState({ byFile: {} });
    storage.map.set(PERSIST_KEY, written!);
    await useDiagnosticsStore.persist.rehydrate();
    expect(useDiagnosticsStore.getState().byFile['/workspace/a.ts']).toMatchObject([{ message: 'boom' }]);
  });

  test('corrupt saved JSON rehydrates to nothing and never throws', async () => {
    const storage = mapStorage();
    globals.window = { sessionStorage: storage };
    useDiagnosticsStore.setState({ byFile: { '/workspace/kept.ts': [{ file: '/workspace/kept.ts', ...diag }] } });
    storage.map.set(PERSIST_KEY, '{not json');

    // rehydrate() returns a thenable, not a Promise; awaiting it throws if it rejects.
    await useDiagnosticsStore.persist.rehydrate();
    expect(useDiagnosticsStore.getState().byFile['/workspace/kept.ts']).toHaveLength(1);
  });

  test('clearStorage removes the sessionStorage entry and leaves localStorage alone', () => {
    const session = mapStorage();
    const local = mapStorage();
    globals.window = { sessionStorage: session, localStorage: local };
    globals.localStorage = local;
    local.map.set(PERSIST_KEY, 'local-copy');

    useDiagnosticsStore.getState().setFileDiagnostics('/workspace/a.ts', [{ file: '/workspace/a.ts', ...diag }]);
    expect(session.map.has(PERSIST_KEY)).toBe(true);

    useDiagnosticsStore.persist.clearStorage();
    expect(session.map.has(PERSIST_KEY)).toBe(false);
    expect(local.map.get(PERSIST_KEY)).toBe('local-copy');
  });

  test('a null sessionStorage (embedded WebView) keeps the store in memory and never throws', async () => {
    globals.window = { sessionStorage: null };
    globals.sessionStorage = null;

    expect(() =>
      useDiagnosticsStore.getState().setFileDiagnostics('/workspace/a.ts', [{ file: '/workspace/a.ts', ...diag }]),
    ).not.toThrow();
    expect(useDiagnosticsStore.getState().byFile['/workspace/a.ts']).toHaveLength(1);

    // rehydrate() returns a thenable, not a Promise; awaiting it throws if it rejects.
    await useDiagnosticsStore.persist.rehydrate();
    expect(useDiagnosticsStore.getState().byFile['/workspace/a.ts']).toHaveLength(1);
    expect(() => useDiagnosticsStore.persist.clearStorage()).not.toThrow();
  });
});
