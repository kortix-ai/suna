#!/usr/bin/env node
// Writes the "exports" map of packages/ui/package.json from the file tree.
//
//   node scripts/gen-exports.mjs           write
//   node scripts/gen-exports.mjs --check   exit 1 when package.json drifts
//
// Rules (one subpath per source module, never a "./*" wildcard):
//   src/index.ts                         → "."
//   ENTRIES (one curated barrel per module) → "./<module>"   ("./session", "./files", "./composer", …)
//   src/primitives/<path>.tsx            → "./<path>"         (subfolders kept: "./dot-matrix/dotm-square-1")
//   src/styles/<name>.css                → "./<name>.css"
//   dist/styles.css                      → "./styles.css"     (built by scripts/build-styles.mjs)
//   DEEP (scripts/deep-exports.json)     → "./<module>/<path>"  (deep path: no semver; only the
//                                          module files a workspace consumer imports today)
// Test files (*.test.*), __snapshots__, *.d.ts, src/test-utils/**, src/types/** and INTERNAL
// modules are never exported. An entry file is exported under its module key only. Any other
// module file is reachable only through its entry, unless DEEP names it.
//
// It also writes "publishConfig.exports", the map npm consumers resolve (see
// scripts/stage-npm-publish.mjs). Same keys; each target maps to the build output:
//   ./src/<path>.ts(x)        → { types: ./dist/<path>.d.ts, import: ./dist/<path>.js }
//   ./src/styles/<name>.css   → ./dist/styles/<name>.css   (copied by scripts/build.mjs)
//   ./dist/styles.css, ./package.json → unchanged
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(PKG_DIR, 'src');
const MODULE = /\.tsx?$/;
const SKIP = /\.test\.tsx?$|\.d\.ts$/;
// Modules other package files import relatively but no host may: build-time
// glyph sources (they pull in react-dom/server) and component-private helpers.
export const INTERNAL = new Set([
  'primitives/glyph-paths-source.tsx',
  'primitives/glyph-paths.generated.ts',
  'primitives/typed-title-logic.ts',
  'primitives/sidebar-peek.ts',
  // Reached through the './theme' barrel only.
  'theme/theme.ts',
  'theme/theme-scope.tsx',
  // A component stylesheet: pptx-renderer.tsx imports it, scripts/build.mjs ships it.
  'files/renderers/pptx-viewer.css',
  // UiProvider's LazyMotion chunk.
  'providers/motion-features.ts',
]);

// One curated barrel per module: the public API. Explicit names, no `export *`.
export const ENTRIES = {
  './icons': 'icons/index.ts',
  './theme': 'theme/index.ts',
  './i18n': 'i18n/index.ts',
  './markdown': 'markdown/index.tsx',
  './genui': 'markdown/genui/index.ts',
  './diff': 'diff/index.ts',
  './changes': 'changes/index.ts',
  './files': 'files/index.ts',
  './file-viewer': 'files/viewer/index.ts',
  './terminal': 'terminal/index.ts',
  './browser': 'browser/index.ts',
  './apps': 'apps/index.ts',
  './composer': 'session/composer/index.ts',
  './session': 'session/index.ts',
  './session-panel': 'session/panel/index.ts',
  './workspace': 'workspace/index.ts',
  './access': 'access/index.ts',
  './customize': 'customize/index.ts',
};
const ENTRY_FILES = new Set(Object.values(ENTRIES));
// Deep keys a workspace consumer imports (tests/unit/ui-deep-exports.test.ts keeps the list exact).
export const DEEP = JSON.parse(readFileSync(join(PKG_DIR, 'scripts', 'deep-exports.json'), 'utf8')).keys;
// Top-level folders that are never exported (test helpers, ambient types, styles have their own rule).
const PRIVATE_DIRS = new Set(['primitives', 'styles', 'test-utils', 'types']);

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
const modules = (dir) =>
  walk(dir).filter((p) => {
    const sub = posix(relative(SRC, p));
    return MODULE.test(p) && !SKIP.test(p) && !INTERNAL.has(sub) && !ENTRY_FILES.has(sub);
  });

export function buildExports() {
  const out = {};
  for (const f of ['index.ts', 'index.tsx']) if (existsSync(join(SRC, f))) out['.'] = rel(join(SRC, f));
  for (const [key, file] of Object.entries(ENTRIES)) {
    if (!existsSync(join(SRC, file))) throw new Error(`gen-exports: entry ${key} → src/${file} does not exist`);
    out[key] = rel(join(SRC, file));
  }
  for (const file of modules(join(SRC, 'primitives'))) {
    out[`./${posix(relative(join(SRC, 'primitives'), file)).replace(MODULE, '')}`] = rel(file);
  }
  for (const key of DEEP) {
    const file = ['.ts', '.tsx'].map((ext) => join(SRC, `${key.slice(2)}${ext}`)).find(existsSync);
    const sub = file && posix(relative(SRC, file));
    if (!file || PRIVATE_DIRS.has(sub.split('/')[0]) || INTERNAL.has(sub) || ENTRY_FILES.has(sub)) {
      throw new Error(`gen-exports: deep key ${key} is not an exportable module file under src/`);
    }
    if (out[key]) throw new Error(`gen-exports: ${key} is both ${out[key]} and ${rel(file)}`);
    out[key] = rel(file);
  }
  for (const file of walk(join(SRC, 'styles')).filter((p) => p.endsWith('.css'))) {
    out[`./${posix(relative(join(SRC, 'styles'), file))}`] = rel(file);
  }
  out['./styles.css'] = './dist/styles.css';
  out['./package.json'] = './package.json';
  const keys = Object.keys(out).sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : 1));
  return Object.fromEntries(keys.map((k) => [k, out[k]]));
}

export function publishTarget(target) {
  if (/\.tsx?$/.test(target) && target.startsWith('./src/')) {
    const base = target.replace(/^\.\/src\//, './dist/').replace(MODULE, '');
    return { types: `${base}.d.ts`, import: `${base}.js` };
  }
  if (target.startsWith('./src/')) return target.replace(/^\.\/src\//, './dist/');
  return target;
}

export function buildPublishExports(exports = buildExports()) {
  return Object.fromEntries(Object.entries(exports).map(([key, target]) => [key, publishTarget(target)]));
}

export function renderPackageJson(current) {
  const pkg = JSON.parse(current);
  pkg.exports = buildExports();
  pkg.publishConfig = { ...pkg.publishConfig, exports: buildPublishExports(pkg.exports) };
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
