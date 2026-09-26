/**
 * The trigger logic of apps/web `read-tool.tsx`, `list-tool.tsx`,
 * `glob-tool.tsx` and `grep-tool.tsx` (web has no tests for these four; the
 * cases pin the web source's branches).
 */
import { describe, expect, test } from 'bun:test';
import {
  SEARCH_TEXT,
  globTrigger,
  grepTrigger,
  listTrigger,
  readBodyKind,
  readLoaded,
  searchBodyKind,
} from './files-search';

describe('globTrigger', () => {
  const out = '/workspace/a.ts\n/workspace/b.ts';

  test('a specific pattern names the row, in mono, with the file count', () => {
    expect(globTrigger({ pattern: '**/*.tsx', path: '/workspace/src', output: out, status: 'completed' })).toEqual({
      label: '**/*.tsx',
      isPathLike: true,
      badge: '2 files',
      filePaths: ['/workspace/a.ts', '/workspace/b.ts'],
      isNoResults: false,
    });
  });

  test('a catch-all pattern gives the row to the searched directory — not its parent', () => {
    expect(globTrigger({ pattern: '**/*', path: ' /workspace/src ', output: out, status: 'completed' }).label).toBe(
      '/workspace/src',
    );
  });

  test('no pattern and no path is prose, not mono', () => {
    expect(globTrigger({ output: '', status: 'running' })).toMatchObject({
      label: 'Everything',
      isPathLike: false,
      badge: undefined,
    });
  });

  test('one file is singular; a settled non-list output is "no matches"', () => {
    expect(globTrigger({ pattern: 'a', output: '/workspace/a.ts', status: 'completed' }).badge).toBe('1 file');
    expect(globTrigger({ pattern: 'a', output: 'No files found', status: 'completed' })).toMatchObject({
      badge: 'no matches',
      isNoResults: true,
    });
  });

  test('an error output is not "no matches"', () => {
    expect(globTrigger({ pattern: 'a', output: 'Error: boom', status: 'completed' }).isNoResults).toBe(false);
  });
});

describe('listTrigger', () => {
  test('Listed/Listing/Couldn’t list, the directory, and the count', () => {
    expect(
      listTrigger({ path: '/workspace/src/', output: '/workspace/src/a.ts', status: 'completed', running: false }),
    ).toMatchObject({ title: 'Listed', subtitle: '/workspace/src', args: ['1 file'] });
    expect(listTrigger({ path: 'src', output: '', status: 'running', running: true })).toMatchObject({
      title: 'Listing',
      subtitle: 'src',
      args: undefined,
    });
    expect(listTrigger({ path: '/w/x', output: 'Error: nope', status: 'completed', running: false })).toMatchObject({
      title: "Couldn't list",
      isNoResults: false,
    });
  });

  test('a settled listing with no paths reads "empty"', () => {
    expect(listTrigger({ path: '/w/x', output: 'nothing here', status: 'completed', running: false })).toMatchObject({
      args: ['empty'],
      isNoResults: true,
    });
    expect(SEARCH_TEXT.directoryEmpty).toBe('Directory is empty');
  });
});

describe('grepTrigger', () => {
  const grepOut = 'Found 2 matches\n\n/workspace/a.ts:\n  Line 3: foo\n  Line 9: foo()';

  test('Searched, the directory of the path, pattern/include args, and the file count', () => {
    const t = grepTrigger({
      path: '/workspace/src/x',
      pattern: 'foo',
      include: '*.ts',
      output: grepOut,
      status: 'completed',
    });
    expect(t.title).toBe('Searched');
    expect(t.subtitle).toBe('/workspace/src');
    expect(t.args).toEqual(['pattern=foo', 'include=*.ts', '1 file']);
    expect(t.groups).toHaveLength(1);
  });

  test('a settled search with nothing parsed is "no matches"; an error is not', () => {
    expect(grepTrigger({ pattern: 'x', output: 'No files found', status: 'completed' })).toMatchObject({
      args: ['pattern=x', 'no matches'],
      isNoResults: true,
    });
    expect(grepTrigger({ pattern: 'x', output: 'Error: bad regex', status: 'completed' }).isNoResults).toBe(false);
    expect(SEARCH_TEXT.noMatchingResults).toBe('No matching results found');
  });
});

describe('searchBodyKind — results, empty state, fallback, nothing', () => {
  test('in web branch order', () => {
    expect(searchBodyKind({ hasResults: true, isNoResults: false, output: 'x' })).toBe('results');
    expect(searchBodyKind({ hasResults: false, isNoResults: true, output: 'x' })).toBe('empty');
    expect(searchBodyKind({ hasResults: false, isNoResults: false, output: 'Error: x' })).toBe('fallback');
    expect(searchBodyKind({ hasResults: false, isNoResults: false, output: '' })).toBeNull();
    expect(SEARCH_TEXT.noMatchingFiles).toBe('No matching files found');
  });
});

describe('ReadTool', () => {
  test('loaded paths come from a completed call only, strings only', () => {
    expect(readLoaded('completed', { loaded: ['/w/a.md', 3, '/w/b.md'] })).toEqual(['/w/a.md', '/w/b.md']);
    expect(readLoaded('running', { loaded: ['/w/a.md'] })).toEqual([]);
    expect(readLoaded('completed', {})).toEqual([]);
  });

  test('body: file content → code; directory entries → list; stale → waiting; error → fallback', () => {
    expect(readBodyKind({ parsed: { type: 'file', content: 'x' }, isStalePending: false, output: '' })).toBe('code');
    expect(readBodyKind({ parsed: { type: 'directory', entries: ['a/', 'b'] }, isStalePending: false, output: '' })).toBe(
      'directory',
    );
    expect(readBodyKind({ parsed: { type: 'directory', entries: [] }, isStalePending: true, output: '' })).toBe('stale');
    expect(readBodyKind({ parsed: null, isStalePending: false, output: 'Error: ENOENT' })).toBe('error');
    expect(readBodyKind({ parsed: { type: 'file', content: '' }, isStalePending: false, output: 'ok' })).toBeNull();
    expect(SEARCH_TEXT.waitingForFileContent).toBe('Waiting for file content...');
  });
});
