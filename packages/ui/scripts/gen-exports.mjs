#!/usr/bin/env node
// Writes the "exports" map of packages/ui/package.json from the file tree.
//
//   node scripts/gen-exports.mjs           write
//   node scripts/gen-exports.mjs --check   exit 1 when package.json drifts
//
// Rules (one subpath per source module, never a "./*" wildcard):
//   src/index.ts                     → "."
//   src/components/ui/<path>.tsx     → "./<path>"         (subfolders kept: "./dot-matrix/dotm-square-1")
//   src/{lib,hooks,icons,providers}/<name>.ts(x) → "./<dir>/<name>"
//   src/chat/index.ts(x)             → "./chat"
//   src/styles/<name>.css            → "./<name>.css"
//   dist/styles.css                  → "./styles.css"     (built by scripts/build-styles.mjs)
// Test files (*.test.*), __snapshots__ and *.d.ts are never exported.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(PKG_DIR, 'src');
const MODULE = /\.tsx?$/;
const SKIP = /\.test\.tsx?$|\.d\.ts$/;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__snapshots__' ? [] : walk(path);
    return [path];
  });
}

const posix = (p) => p.split(sep).join('/');
const rel = (p) => `./${posix(relative(PKG_DIR, p))}`;
const modules = (dir) => walk(dir).filter((p) => MODULE.test(p) && !SKIP.test(p));

export function buildExports() {
  const out = {};
  for (const f of ['index.ts', 'index.tsx']) if (existsSync(join(SRC, f))) out['.'] = rel(join(SRC, f));
  for (const f of ['index.ts', 'index.tsx'])
    if (existsSync(join(SRC, 'chat', f))) out['./chat'] = rel(join(SRC, 'chat', f));
  for (const file of modules(join(SRC, 'components', 'ui'))) {
    out[`./${posix(relative(join(SRC, 'components', 'ui'), file)).replace(MODULE, '')}`] = rel(file);
  }
  for (const dir of ['lib', 'hooks', 'icons', 'providers']) {
    for (const file of modules(join(SRC, dir))) {
      out[`./${dir}/${posix(relative(join(SRC, dir), file)).replace(MODULE, '')}`] = rel(file);
    }
  }
  for (const file of walk(join(SRC, 'styles')).filter((p) => p.endsWith('.css'))) {
    out[`./${posix(relative(join(SRC, 'styles'), file))}`] = rel(file);
  }
  out['./styles.css'] = './dist/styles.css';
  out['./package.json'] = './package.json';
  const keys = Object.keys(out).sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : 1));
  return Object.fromEntries(keys.map((k) => [k, out[k]]));
}

export function renderPackageJson(current) {
  const pkg = JSON.parse(current);
  pkg.exports = buildExports();
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = join(PKG_DIR, 'package.json');
  const current = readFileSync(file, 'utf8');
  const next = renderPackageJson(current);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('gen-exports: packages/ui/package.json exports drift. Run: pnpm --filter @kortix/ui gen-exports');
      process.exit(1);
    }
    console.log('gen-exports: no drift');
  } else if (next !== current) {
    writeFileSync(file, next);
    console.log(`gen-exports: wrote ${Object.keys(JSON.parse(next).exports).length} exports`);
  } else {
    console.log('gen-exports: up to date');
  }
}
