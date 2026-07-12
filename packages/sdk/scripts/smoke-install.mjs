#!/usr/bin/env node
/**
 * Packs @kortix/sdk exactly as `npm publish` would, installs the tarball into a
 * throwaway project, and imports it in Node ESM.
 *
 * This is the ONLY check that exercises the published artifact's module
 * resolution. `npm pack --dry-run` lists tarball contents; stage-npm-publish.mjs
 * asserts publishConfig paths exist in dist/. Neither proves the thing imports.
 *
 * @kortix/llm-catalog is a workspace:* dependency that stage-npm-publish.mjs
 * pins to the release version — the SDK and the catalog co-publish in lockstep.
 * The smoke run mirrors that: it packs the catalog at the same synthetic
 * version and installs both tarballs together, so the pinned dependency
 * resolves hermetically instead of hitting the registry for a version that
 * only exists during this run.
 *
 * Run from packages/sdk:  node scripts/smoke-install.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG_DIR = process.cwd();
const CATALOG_DIR = join(PKG_DIR, '..', 'llm-catalog');

/** `execFileSync` takes an options object — cwd and env both live there. */
const run = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, { cwd, env: env ?? process.env, stdio: 'pipe', encoding: 'utf8' });

const stage = (dir) =>
  run('node', ['../../scripts/stage-npm-publish.mjs'], dir, {
    ...process.env,
    VERSION: '0.0.0-smoke',
  });

const backup = join(tmpdir(), `kortix-sdk-pkg-${process.pid}.json`);
const catalogBackup = join(tmpdir(), `kortix-llm-catalog-pkg-${process.pid}.json`);
const workdir = mkdtempSync(join(tmpdir(), 'kortix-sdk-smoke-'));
let staged = false;
let catalogStaged = false;
let tarballPath;
let catalogTarballPath;

try {
  console.log('→ building dist/');
  // build:bundles also emits the tsup browser bundles (dist/kortix.esm.min.js,
  // dist/kortix.global.js) that publishConfig.browser/unpkg/jsdelivr point at.
  // stage() below promotes those fields and verifies they exist in dist/, so
  // they must be built before staging — plain `build` only runs tsc.
  run('pnpm', ['run', 'build:bundles'], PKG_DIR);
  run('pnpm', ['run', 'build'], CATALOG_DIR);

  console.log('→ staging the published manifests');
  copyFileSync(join(PKG_DIR, 'package.json'), backup);
  staged = true;
  stage(PKG_DIR);
  copyFileSync(join(CATALOG_DIR, 'package.json'), catalogBackup);
  catalogStaged = true;
  stage(CATALOG_DIR);

  console.log('→ npm pack');
  const tarball = run('npm', ['pack', '--silent'], PKG_DIR).trim().split('\n').pop();
  tarballPath = join(PKG_DIR, tarball);
  const catalogTarball = run('npm', ['pack', '--silent'], CATALOG_DIR).trim().split('\n').pop();
  catalogTarballPath = join(CATALOG_DIR, catalogTarball);

  console.log(`→ installing ${catalogTarball} + ${tarball} into ${workdir}`);
  writeFileSync(
    join(workdir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2),
  );
  run('npm', ['install', '--no-audit', '--no-fund', catalogTarballPath, tarballPath], workdir);

  console.log('→ importing in Node ESM');
  writeFileSync(
    join(workdir, 'smoke.mjs'),
    [
      "import { createKortix, ApiError, classifyTurn } from '@kortix/sdk';",
      "import { createScopedKortix } from '@kortix/sdk/server';",
      "if (typeof createKortix !== 'function') throw new Error('createKortix is not a function');",
      "if (typeof classifyTurn !== 'function') throw new Error('classifyTurn is not a function');",
      "if (typeof createScopedKortix !== 'function') throw new Error('createScopedKortix missing');",
      "if (!(new ApiError('x') instanceof Error)) throw new Error('ApiError is not an Error');",
      "const k = createKortix({ backendUrl: 'http://smoke.test/v1', getToken: async () => null });",
      "if (typeof k.projects.list !== 'function') throw new Error('facade is not wired');",
      "console.log('OK: @kortix/sdk imports and constructs from a packed tarball');",
    ].join('\n'),
  );
  process.stdout.write(run('node', ['smoke.mjs'], workdir));

  console.log('✔ install smoke test passed');
} finally {
  // Every cleanup/restore step must run even if an earlier one throws. Flat
  // statements meant the FIRST failure (e.g. the copyFileSync that restores the
  // real package.json) skipped everything after it — leaving packages/sdk/
  // package.json staged with the throwaway `0.0.0-smoke` dist manifest in the
  // working tree. Run each step in isolation, collect failures, and rethrow them
  // as one aggregate so a cleanup fault stays loud instead of being swallowed.
  const cleanupErrors = [];
  const step = (fn) => {
    try {
      fn();
    } catch (err) {
      cleanupErrors.push(err);
    }
  };
  if (staged) step(() => copyFileSync(backup, join(PKG_DIR, 'package.json')));
  if (catalogStaged) step(() => copyFileSync(catalogBackup, join(CATALOG_DIR, 'package.json')));
  step(() => rmSync(backup, { force: true }));
  step(() => rmSync(catalogBackup, { force: true }));
  if (tarballPath) step(() => rmSync(tarballPath, { force: true }));
  if (catalogTarballPath) step(() => rmSync(catalogTarballPath, { force: true }));
  step(() => rmSync(workdir, { recursive: true, force: true }));
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'smoke-install cleanup failed');
  }
}
