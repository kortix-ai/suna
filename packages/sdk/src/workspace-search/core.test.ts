import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeWorkspaceSearchEntries,
  normalizeWorkspacePath,
  searchIndexedWorkspaceEntries,
  toWorkspaceSearchEntry,
} from './core';

test('normalizes relative paths into /workspace paths', () => {
  assert.equal(normalizeWorkspacePath('src/app.tsx'), '/workspace/src/app.tsx');
  assert.equal(normalizeWorkspacePath('/workspace/src/app.tsx/'), '/workspace/src/app.tsx');
});

test('finds exact deep path matches before shallow partial matches', () => {
  const exactPath =
    '/workspace/.local/share/opencode/storage/session_diff/ses_29fc6e281ffet54CZfUqSZlkE2.json';
  const entries = [
    toWorkspaceSearchEntry('/workspace/session_diff.json'),
    toWorkspaceSearchEntry('/workspace/.local/share/opencode/storage/session_diff/other.json'),
    toWorkspaceSearchEntry(exactPath),
    toWorkspaceSearchEntry('/workspace/.local/share/opencode/storage/session_diff', true),
  ];

  const results = searchIndexedWorkspaceEntries(entries, exactPath, { limit: 5 });

  assert.equal(results[0]?.path, exactPath);
});

test('matches relative deep path queries against indexed files', () => {
  const exactPath =
    '/workspace/.local/share/opencode/storage/session_diff/ses_29fc6e281ffet54CZfUqSZlkE2.json';
  const entries = [
    toWorkspaceSearchEntry(exactPath),
    toWorkspaceSearchEntry('/workspace/.local/share/opencode/storage/session_diff/older.json'),
    toWorkspaceSearchEntry('/workspace/src/app.tsx'),
  ];

  const results = searchIndexedWorkspaceEntries(
    entries,
    '.local/share/opencode/storage/session_diff/ses_29fc6e281ffet54CZfUqSZlkE2.json',
    { limit: 5, type: 'file' },
  );

  assert.equal(results[0]?.path, exactPath);
});

test('dedupes backend and fallback search results before ranking', () => {
  const exactPath =
    '/workspace/.local/share/opencode/storage/session_diff/ses_29fc6e281ffet54CZfUqSZlkE2.json';
  const merged = mergeWorkspaceSearchEntries(
    [toWorkspaceSearchEntry(exactPath)],
    [toWorkspaceSearchEntry(exactPath), toWorkspaceSearchEntry('/workspace/src/app.tsx')],
    'ses_29fc6e281ffet54CZfUqSZlkE2.json',
    { limit: 5 },
  );

  assert.equal(merged.filter((entry) => entry.path === exactPath).length, 1);
});

test('pins normalization, parsing, matching, rank and stable tie order', async () => {
  const {
    normalizeSearchQuery,
    stripWorkspacePrefix,
    parseWorkspacePaths,
    workspaceQueryLooksPathLike,
    workspaceEntryMatchesQuery,
    rankWorkspaceSearchEntry,
    dedupeWorkspaceSearchEntries,
  } = await import('./core');
  assert.equal(normalizeSearchQuery('  workspace\\src\\  '), 'workspace/src');
  assert.equal(stripWorkspacePrefix('/workspace/src/a.ts'), 'src/a.ts');
  assert.deepEqual(parseWorkspacePaths(['src/', 'src/', 'src/a.ts'], ['src']), [
    toWorkspaceSearchEntry('src', true),
    toWorkspaceSearchEntry('src/a.ts'),
  ]);
  assert.equal(workspaceQueryLooksPathLike('src/a'), true);
  assert.equal(workspaceEntryMatchesQuery(toWorkspaceSearchEntry('src/a.ts'), 'src/a'), true);
  assert.ok(
    rankWorkspaceSearchEntry(toWorkspaceSearchEntry('src/a.ts'), 'src/a.ts') <
      rankWorkspaceSearchEntry(toWorkspaceSearchEntry('src/ab.ts'), 'src/a.ts'),
  );
  assert.equal(
    dedupeWorkspaceSearchEntries([
      toWorkspaceSearchEntry('src/a.ts'),
      toWorkspaceSearchEntry('src/a.ts'),
    ]).length,
    1,
  );
  assert.deepEqual(
    searchIndexedWorkspaceEntries(
      [toWorkspaceSearchEntry('z/a.ts'), toWorkspaceSearchEntry('a/a.ts')],
      'a.ts',
    ).map((e) => e.path),
    ['/workspace/a/a.ts', '/workspace/z/a.ts'],
  );
});

test('runtime-files policy preserves raw paths and legacy ranking without changing defaults', async () => {
  const { rankWorkspaceSearchEntry, workspaceEntryMatchesQuery } = await import('./core');
  const entry = (path: string) => ({ path, name: 'ignored', isDir: false });
  const policy = 'runtime-files' as const;
  for (const [path, query, rank] of [
    ['a//APP', ' app ', 0.02], ['x/app.ts', 'app', 10.01],
    ['x/myapp.ts', 'app', 20.01], ['app/z.ts', 'app', 30.01],
    ['x/app/z.ts', 'app', 40.02], ['other.ts', 'app', 1000],
    ['a//b', ' ', 2], ['src\\app.ts', 'app', 20],
  ] as const) {
    assert.equal(rankWorkspaceSearchEntry(entry(path), query, policy), rank);
  }
  assert.equal(workspaceEntryMatchesQuery(entry('src//app.ts'), 'src/app', policy), false);
  assert.equal(workspaceEntryMatchesQuery(entry('src//app.ts'), ' SRC//APP ', policy), true);
  assert.equal(workspaceEntryMatchesQuery(entry('src\\app.ts'), 'src\\app', policy), true);
  assert.equal(workspaceEntryMatchesQuery(entry('src/a-p-p.ts'), 'app', policy), false);
  assert.equal(workspaceEntryMatchesQuery(entry('anything'), ' ', policy), true);
  assert.equal(workspaceEntryMatchesQuery(toWorkspaceSearchEntry('src/a-p-p.ts'), 'app'), true);
  assert.equal(rankWorkspaceSearchEntry(toWorkspaceSearchEntry('app'), 'app'), 0.001);
});
