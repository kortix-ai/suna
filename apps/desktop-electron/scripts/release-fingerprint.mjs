#!/usr/bin/env bun
// The fingerprint of everything that goes into a production desktop build.
//
// deploy-prod.yml compares it with the fingerprint the previous vX.Y.Z release
// carries (its DESKTOP-FINGERPRINT asset). Equal fingerprints: the release
// copies the previous installers and latest*.yml instead of building new ones,
// so installed apps keep their version and electron-updater offers no update.
// Any input below that changes produces a new build with the release version.
//
// Inputs:
//   1. Every tracked file of apps/desktop-electron and packages/agent-tunnel
//      (the agent is bundled into the app), except tests, READMEs and this
//      script (it builds nothing).
//   2. The resolved dependency closure of both packages in pnpm-lock.yaml:
//      every package name, version and integrity they can load. A lockfile
//      change elsewhere in the monorepo does not change it. `@types/*`
//      packages ship no code (electron depends on @types/node) and are left out.
//   3. The `build-desktop` job of deploy-prod.yml without `needs`/`if`: the
//      runners, the bun version and the electron-builder flags.
//   4. The root .npmrc (install behavior).
//
// Not covered: secrets baked at build time (the Sentry DSN, the signing
// certificates). After rotating one, dispatch deploy-prod with
// rebuild_desktop=true.
//
// Usage (repo root): bun apps/desktop-electron/scripts/release-fingerprint.mjs [--explain]
// Prints the hex fingerprint. --explain prints each input's hash as JSON.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const SOURCE_DIRS = ['apps/desktop-electron', 'packages/agent-tunnel'];
const IGNORED = /(\.test\.[cm]?[jt]sx?|(^|\/)README\.md|\/scripts\/release-fingerprint\.mjs)$/;
// Runtime and build dependencies. agent-tunnel's devDependencies are type
// checkers only: bun bundles the agent without them.
const IMPORTERS = {
  'apps/desktop-electron': ['dependencies', 'devDependencies', 'optionalDependencies'],
  'packages/agent-tunnel': ['dependencies', 'optionalDependencies'],
};
const WORKFLOW = '.github/workflows/deploy-prod.yml';
const JOB = 'build-desktop';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** `<mode> <blob sha> <path>` of every packaged source file, sorted by path. */
export function sourceFiles(root = ROOT) {
  const out = execFileSync('git', ['ls-files', '-s', '--', ...SOURCE_DIRS], { cwd: root, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [mode, blob] = meta.split(' ');
      return { mode, blob, path };
    })
    .filter((f) => !IGNORED.test(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => `${f.mode} ${f.blob} ${f.path}`);
}

/**
 * `<key> <integrity>` of every package the importers reach, sorted. Reads the
 * pnpm lockfile v6 layout: importers[path][field][name].version, and
 * packages["/<name>@<version>"] with dependencies/optionalDependencies maps.
 */
export function dependencyClosure(lock) {
  const seen = new Map();
  const queue = [];
  const visit = (name, version) => {
    if (typeof version !== 'string' || version.startsWith('link:') || name.startsWith('@types/')) return;
    // A dependency may be aliased to another package: `/<real>@<version>`.
    const key = version.startsWith('/') ? version : `/${name}@${version}`;
    if (seen.has(key)) return;
    const entry = lock.packages?.[key];
    if (!entry) throw new Error(`pnpm-lock.yaml has no entry for ${key}`);
    seen.set(key, entry.resolution?.integrity ?? entry.resolution?.tarball ?? '');
    queue.push(entry);
  };
  for (const [importer, fields] of Object.entries(IMPORTERS)) {
    const node = lock.importers?.[importer];
    if (!node) throw new Error(`pnpm-lock.yaml has no importer ${importer}`);
    for (const field of fields) {
      for (const [name, dep] of Object.entries(node[field] ?? {})) visit(name, dep.version);
    }
  }
  while (queue.length) {
    const entry = queue.shift();
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(entry[field] ?? {})) visit(name, version);
    }
  }
  return [...seen].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, integrity]) => `${key} ${integrity}`);
}

/** The build-desktop job without its scheduling keys, as canonical JSON. */
export function buildJob(workflow) {
  const job = workflow?.jobs?.[JOB];
  if (!job) throw new Error(`${WORKFLOW} has no job ${JOB}`);
  const { needs: _needs, if: _if, ...content } = job;
  return JSON.stringify(content);
}

export function fingerprint(root = ROOT) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const parts = {
    sources: sha256(sourceFiles(root).join('\n')),
    dependencies: sha256(dependencyClosure(Bun.YAML.parse(read('pnpm-lock.yaml'))).join('\n')),
    buildJob: sha256(buildJob(Bun.YAML.parse(read(WORKFLOW)))),
    npmrc: sha256(read('.npmrc')),
  };
  return { fingerprint: sha256(JSON.stringify(parts)), parts };
}

if (import.meta.main) {
  const result = fingerprint();
  console.log(process.argv.includes('--explain') ? JSON.stringify(result, null, 2) : result.fingerprint);
}
