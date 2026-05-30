import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeWorkspaceSearchEntries,
  normalizeWorkspacePath,
  searchIndexedWorkspaceEntries,
  toWorkspaceSearchEntry,
} from './workspace-search-core.ts';

test('normalizes relative paths into /workspace paths', () => {
  assert.equal(normalizeWorkspacePath('src/app.tsx'), '/workspace/src/app.tsx');
  assert.equal(normalizeWorkspacePath('/workspace/src/app.tsx/'), '/workspace/src/app.tsx');
});

test('finds exact deep path matches before shallow partial matches', () => {
  const exactPath = '/workspace/.local/share/opencode/storage/session_diff/ses_29fc6e281ffet54CZfUqSZlkE2.json';
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
  const exactPath = '/workspace/.local/share/opencode/storage/session_diff/ses_29fc6e281ffet54CZfUqSZlkE2.json';
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
  const exactPath = '/workspace/.local/share/opencode/storage/session_diff/ses_29fc6e281ffet54CZfUqSZlkE2.json';
  const merged = mergeWorkspaceSearchEntries(
    [toWorkspaceSearchEntry(exactPath)],
    [toWorkspaceSearchEntry(exactPath), toWorkspaceSearchEntry('/workspace/src/app.tsx')],
    'ses_29fc6e281ffet54CZfUqSZlkE2.json',
    { limit: 5 },
  );

  assert.equal(merged.filter((entry) => entry.path === exactPath).length, 1);
});
