/**
 * The fast-boot delta bundle on a partial project store: it downloads the
 * objects of `tip ^root` and nothing the scaffold root already holds.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { __clearOverLimitMemoForTests } from '../../shared/over-limit-memo';
import { createPartialStoreFixture, type PartialStoreFixture } from './__tests__/partial-store-fixture';
import { buildScaffoldDeltaBundle, writeScaffoldDeltaBundle } from './fast-boot-bundle';
import { refreshMirror } from './mirror';

let fx: PartialStoreFixture | null = null;
afterEach(async () => {
  __clearOverLimitMemoForTests();
  await fx?.cleanup();
  fx = null;
});

/** A scaffold root with a large file, then project commits on top. */
async function scaffoldedProject(delta: Record<string, string | Buffer>): Promise<PartialStoreFixture> {
  const fixture = await createPartialStoreFixture({ 'kortix.yaml': 'name: x\n', 'scaffold/big.bin': randomBytes(400_000) });
  await fixture.push(delta, 'project work');
  await fixture.push({ 'notes.md': 'n\n' }, 'notes');
  return fixture;
}

test('the bundle downloads the delta only, and the upstream verifies it', async () => {
  fx = await scaffoldedProject({ 'app/main.ts': 'export {}\n', 'app/data.bin': randomBytes(100_000) });
  const store = await refreshMirror(fx.project);

  const bundle = await buildScaffoldDeltaBundle(store, 'main', { projectId: fx.project.projectId });

  expect(bundle).not.toBeNull();
  expect(bundle!.bundleBase64).toBeNull();
  expect(bundle!.bundleBytes).toBeGreaterThan(100_000);
  expect(await fx.storeHas(await fx.upstreamBlob('app/data.bin'))).toBe(true);
  expect(await fx.storeHas(await fx.upstreamBlob('scaffold/big.bin'))).toBe(false);

  // The remote download route writes the same bundle; the upstream holds the root, so it verifies it.
  const out = join(fx.root, 'delta.bundle');
  await writeScaffoldDeltaBundle(store, 'main', bundle!.baseSha, bundle!.parentSha, out);
  execFileSync('git', ['bundle', 'verify', '-q', out], { cwd: fx.upstream });
});

test('over the cap: no bundle, no downloaded file, and the project is remembered', async () => {
  fx = await scaffoldedProject({ 'app/data.bin': randomBytes(2_000_000) });
  const store = await refreshMirror(fx.project);
  const data = await fx.upstreamBlob('app/data.bin');

  expect(await buildScaffoldDeltaBundle(store, 'main', { projectId: fx.project.projectId, maxBytes: 200_000 })).toBeNull();
  expect(await fx.storeHas(data)).toBe(false);

  // Remembered: under the default cap the delta fits, yet no bundle is built and nothing downloads.
  expect(await buildScaffoldDeltaBundle(store, 'main', { projectId: fx.project.projectId })).toBeNull();
  expect(await fx.storeHas(data)).toBe(false);

  __clearOverLimitMemoForTests();
  const bundle = await buildScaffoldDeltaBundle(store, 'main', { projectId: fx.project.projectId });
  expect(bundle?.bundleBytes).toBeGreaterThan(2_000_000);
});
