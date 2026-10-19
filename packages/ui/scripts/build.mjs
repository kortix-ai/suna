#!/usr/bin/env node
// Builds the npm artifact of @kortix/ui into dist/ (the workspace resolves src/;
// npm consumers resolve publishConfig.exports → dist/).
//
//   pnpm --filter @kortix/ui build
//
// 1. tsc -p tsconfig.build.json emits one ESM .js + .d.ts per source module.
//    Per-file emit keeps each module's 'use client' directive where it was.
// 2. tsc-alias --resolve-full-paths adds the .js / /index.js suffixes Node ESM needs.
// 3. src/styles/*.css are copied to dist/styles/ (theme.css's `@source "../"` then
//    scans dist/, the published class strings).
// 4. @kortix/shared is private, so it is inlined: the names dist imports from it are
//    bundled (tree-shaken) into dist/_vendor/kortix-shared.js and every
//    '@kortix/shared' specifier in dist/**/*.js is rewritten to that file. A .d.ts
//    that names @kortix/shared fails the build.
// 5. Guards: no '@kortix/shared' specifier is left, every source 'use client' survives,
//    every publishConfig.exports target exists, the i18n and provider entries load in Node.
// dist/styles.css is built separately (scripts/build-styles.mjs) and committed; this
// script keeps it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(PKG_DIR, 'src');
const DIST = join(PKG_DIR, 'dist');
const BIN = join(PKG_DIR, 'node_modules', '.bin');
const KEEP = new Set(['styles.css']);
const SHARED = /(['"])(@kortix\/shared)\1/g;
const posix = (p) => p.split(sep).join('/');

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

// 1–3. Clean (keep the committed stylesheet), compile, fix specifiers, copy CSS.
mkdirSync(DIST, { recursive: true });
for (const name of readdirSync(DIST)) if (!KEEP.has(name)) rmSync(join(DIST, name), { recursive: true, force: true });
const tsc = (bin, args) => execFileSync(join(BIN, bin), args, { cwd: PKG_DIR, stdio: 'inherit' });
tsc('tsc', ['-p', 'tsconfig.build.json']);
tsc('tsc-alias', ['-p', 'tsconfig.build.json', '--resolve-full-paths']);
mkdirSync(join(DIST, 'styles'), { recursive: true });
for (const css of readdirSync(join(SRC, 'styles')).filter((n) => n.endsWith('.css'))) {
  copyFileSync(join(SRC, 'styles', css), join(DIST, 'styles', css));
}

// 4. Inline @kortix/shared.
const emitted = walk(DIST).filter((p) => /\.(js|d\.ts)$/.test(p));
const values = new Set();
for (const file of emitted) {
  const text = readFileSync(file, 'utf8');
  if (!/['"]@kortix\/shared/.test(text)) continue;
  const at = posix(relative(PKG_DIR, file));
  // Published types must not name the private package. No .d.ts does today; one that
  // does needs its type declared in packages/ui, not inlined from @kortix/shared.
  if (file.endsWith('.d.ts')) fail(`${at}: a published type references the private '@kortix/shared'`);
  if (/import\s*\*\s*as\s+\w+\s+from\s*['"]@kortix\/shared|['"]@kortix\/shared\//.test(text)) {
    fail(`${at}: only named imports from the '@kortix/shared' root can be inlined`);
  }
  for (const m of text.matchAll(/import\s+\{([^}]*)\}\s*from\s*['"]@kortix\/shared['"]/g)) {
    for (const spec of m[1].split(',').map((s) => s.trim()).filter(Boolean)) values.add(spec.split(/\s+as\s+/)[0]);
  }
}

if (values.size > 0) {
  const cache = join(PKG_DIR, 'node_modules', '.cache', 'kortix-ui-vendor');
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  const entry = join(cache, 'kortix-shared.ts');
  writeFileSync(entry, `export { ${[...values].sort().join(', ')} } from '@kortix/shared';\n`);
  const { build } = await import('tsup');
  await build({
    entry: { 'kortix-shared': entry },
    outDir: join(DIST, '_vendor'),
    format: ['esm'],
    platform: 'neutral',
    target: 'es2022',
    bundle: true,
    splitting: false,
    treeshake: true,
    noExternal: [/^@kortix\/shared/],
    tsconfig: join(PKG_DIR, 'tsconfig.json'),
    silent: true,
    clean: false,
    // @kortix/shared declares no "sideEffects", so esbuild would keep every module of
    // its root barrel. Its modules are side-effect free; only the named exports stay.
    esbuildPlugins: [
      {
        name: 'kortix-shared-side-effect-free',
        setup(b) {
          b.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData?.inner) return undefined;
            const { path, errors, external } = await b.resolve(args.path, {
              kind: args.kind,
              importer: args.importer,
              resolveDir: args.resolveDir,
              pluginData: { inner: true },
            });
            if (errors.length || external || !/[\\/]packages[\\/]shared[\\/]src[\\/]/.test(path)) return undefined;
            return { path, sideEffects: false };
          });
        },
      },
    ],
  });
  rmSync(cache, { recursive: true, force: true });
  const vendor = join(DIST, '_vendor', 'kortix-shared.js');
  for (const file of emitted) {
    const text = readFileSync(file, 'utf8');
    if (!/['"]@kortix\/shared['"]/.test(text)) continue;
    let target = posix(relative(dirname(file), vendor));
    if (!target.startsWith('.')) target = `./${target}`;
    writeFileSync(file, text.replace(SHARED, (_, q) => `${q}${target}${q}`));
  }
}

// 5. Guards.
const leftover = walk(DIST)
  .filter((p) => /\.(js|d\.ts)$/.test(p))
  .filter((p) => /from\s*['"]@kortix\/shared|import\(\s*['"]@kortix\/shared/.test(readFileSync(p, 'utf8')));
if (leftover.length) fail(`'@kortix/shared' is still imported by: ${leftover.map((p) => posix(relative(PKG_DIR, p))).join(', ')}`);

const DIRECTIVE = /^['"]use client['"]/;
const lostDirective = walk(SRC)
  .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$|\.d\.ts$/.test(p) && !p.includes(`${sep}test-utils${sep}`))
  .filter((p) => DIRECTIVE.test(readFileSync(p, 'utf8')))
  .map((p) => join(DIST, relative(SRC, p)).replace(/\.tsx?$/, '.js'))
  .filter((out) => !existsSync(out) || !DIRECTIVE.test(readFileSync(out, 'utf8')));
if (lostDirective.length) fail(`'use client' missing from: ${lostDirective.map((p) => posix(relative(PKG_DIR, p))).join(', ')}`);

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const targets = Object.values(pkg.publishConfig.exports).flatMap((t) => (typeof t === 'string' ? [t] : Object.values(t)));
const missing = targets.filter((t) => !existsSync(join(PKG_DIR, t)));
if (missing.length) fail(`publishConfig.exports targets missing after build: ${missing.join(', ')}`);

// Plain Node ESM loads the entry points that hold data or contexts (no bundler, no
// JSON import attributes): Vite SSR, Remix and Node prerendering resolve dist/ this way.
for (const entry of ['dist/i18n/index.js', 'dist/providers/session-ids.js', 'dist/providers/ui-provider.js']) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(`./${entry}`)});`], {
      cwd: PKG_DIR,
      stdio: 'pipe',
    });
  } catch (error) {
    fail(`${entry} does not load in Node ESM: ${String(error.stderr ?? error).split('\n').find(Boolean)}`);
  }
}

const js = walk(DIST).filter((p) => p.endsWith('.js')).length;
console.log(
  `build: dist/ ${js} .js modules, ${targets.length} export targets present, @kortix/shared inlined (${[...values].sort().join(', ') || 'nothing'})`,
);
