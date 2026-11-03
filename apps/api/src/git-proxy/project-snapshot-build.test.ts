/**
 * The project snapshot build on a partial project store: it downloads every
 * file of the commit, bounded by the snapshot cap, before the checkout.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { createPartialStoreFixture, type PartialStoreFixture } from '../projects/git/__tests__/partial-store-fixture';
import { refreshMirror } from '../projects/git/mirror';
import { __clearOverLimitMemoForTests } from '../shared/over-limit-memo';
import { buildProjectSnapshotArchive, ProjectSnapshotTooLargeError } from './project-snapshot-build';

const REPOSITORY = { owner: 'acme', name: 'app', externalId: '1' };
const settings = config as { KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES: number };
const defaultMax = settings.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES;

let fx: PartialStoreFixture | null = null;
afterEach(async () => {
  settings.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES = defaultMax;
  __clearOverLimitMemoForTests();
  await fx?.cleanup();
  fx = null;
});

test('builds the commit from a store that held none of its files, and downloads no older version', async () => {
  fx = await createPartialStoreFixture({ 'kortix.yaml': 'name: x\n', 'src/app.ts': 'console.log(1)\n', 'data/a.bin': randomBytes(200_000) });
  const tip = await fx.push({ 'src/app.ts': 'console.log(2)\n' }, 'second');
  await refreshMirror(fx.project);
  expect(await fx.storeHas(await fx.upstreamBlob('data/a.bin'))).toBe(false);

  const built = await buildProjectSnapshotArchive(fx.project, REPOSITORY, 'main', tip);
  try {
    const listed = execFileSync('tar', ['-tzf', built.treePath], { encoding: 'utf8' });
    expect(listed).toContain('./src/app.ts');
    expect(listed).toContain('./data/a.bin');
    expect(built.blobsBytes).toBeGreaterThan(200_000);
    expect(await fx.storeHas(await fx.upstreamBlob('data/a.bin'))).toBe(true);
    expect(await fx.storeHas(await fx.upstreamBlob('src/app.ts', `${tip}~1`))).toBe(false);
  } finally {
    await built.cleanup();
  }
});

test('over the cap: too large, nothing kept, and remembered for the project until the memo clears', async () => {
  fx = await createPartialStoreFixture({ 'kortix.yaml': 'name: x\n', 'data/big.bin': randomBytes(3_000_000) });
  const big = await fx.upstreamBlob('data/big.bin');
  settings.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES = 200_000;

  const tip = await fx.push({ 'notes.md': 'n\n' }, 'notes');
  const over = await buildProjectSnapshotArchive(fx.project, REPOSITORY, 'main', tip).catch((error: unknown) => error);
  expect(over).toBeInstanceOf(ProjectSnapshotTooLargeError);
  expect(await fx.storeHas(big)).toBe(false);
  expect(await fx.storeHas(await fx.upstreamBlob('kortix.yaml'))).toBe(false);

  // The large file is gone, but the memo answers without a build.
  const small = await fx.push({ 'data/big.bin': null }, 'drop data');
  const remembered = await buildProjectSnapshotArchive(fx.project, REPOSITORY, 'main', small).catch((error: unknown) => error);
  expect(remembered).toBeInstanceOf(ProjectSnapshotTooLargeError);
  expect(await fx.storeHas(await fx.upstreamBlob('notes.md'))).toBe(false);

  __clearOverLimitMemoForTests();
  const built = await buildProjectSnapshotArchive(fx.project, REPOSITORY, 'main', small);
  await built.cleanup();
  expect(await fx.storeHas(await fx.upstreamBlob('notes.md'))).toBe(true);
});
