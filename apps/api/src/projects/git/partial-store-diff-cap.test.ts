// A diff whose changed files weigh more than its fetch cap, on a partial
// project store (object-store.ts): nothing is downloaded, and the review lists
// the files without renames, line counts or patch. The cap is lowered from
// 64 MB to 100 KB so the test pushes 300 KB instead of 64 MB.
import { afterEach, expect, mock, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createPartialStoreFixture, type PartialStoreFixture } from './__tests__/partial-store-fixture';

const TEST_CAP_BYTES = 100_000;
const commits = { ...(await import('./commits')) };
mock.module('./commits', () => ({
  ...commits,
  ensureDiffBlobs: (repoPath: string, command: string[], operands: string[]) =>
    commits.ensureDiffBlobs(repoPath, command, operands, TEST_CAP_BYTES),
}));
const { getBranchDiff } = await import('./merge');
const { refreshMirror } = await import('./mirror');

let fx: PartialStoreFixture | null = null;
afterEach(async () => {
  await fx?.cleanup();
  fx = null;
});

test('a branch over the cap lists its files without counts or patch, and fetches no file', async () => {
  fx = await createPartialStoreFixture({ 'kortix.yaml': 'name: lab\n', 'notes.md': 'hello\n' });
  await fx.push({ 'data/run.bin': randomBytes(300_000), 'notes.md': null, 'docs/notes.md': 'hello\n' }, 'add data', 'feature');
  const diff = await getBranchDiff(fx.project, 'main', 'feature');
  // Without the content git cannot detect the rename: it lists a delete and an add.
  expect(diff.files.map((file) => [file.path, file.status, file.additions])).toEqual([
    ['data/run.bin', 'added', 0],
    ['docs/notes.md', 'added', 0],
    ['notes.md', 'deleted', 0],
  ]);
  expect(diff.patch).toBe('');
  expect(diff.patch_truncated).toBe(true);
  expect(await fx.storeHas(await fx.upstreamBlob('data/run.bin', 'feature'))).toBe(false);
  expect(await fx.storeHas(await fx.upstreamBlob('docs/notes.md', 'feature'))).toBe(false);
});

test('ensureDiffBlobs fetches a diff under the cap in one request and reports one over it', async () => {
  fx = await createPartialStoreFixture({ 'kortix.yaml': 'name: lab\n' });
  await fx.push({ 'small.md': 'small\n' }, 'small', 'small');
  await fx.push({ 'large.bin': randomBytes(300_000) }, 'large', 'large');
  const store = await refreshMirror(fx.project, true);
  expect(await commits.ensureDiffBlobs(store, ['diff'], ['main...small'], TEST_CAP_BYTES)).toBe(true);
  expect(await fx.storeHas(await fx.upstreamBlob('small.md', 'small'))).toBe(true);
  expect(await commits.ensureDiffBlobs(store, ['diff'], ['main...large'], TEST_CAP_BYTES)).toBe(false);
  expect(await fx.storeHas(await fx.upstreamBlob('large.bin', 'large'))).toBe(false);
});
