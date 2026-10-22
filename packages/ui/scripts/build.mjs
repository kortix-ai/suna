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
// 4. @kortix/shared and @kortix/manifest-schema are private, so they are inlined: the
//    names dist imports from their roots or subpaths are bundled (tree-shaken) into
//    dist/_vendor/kortix-shared.js; the
//    shared modules a .d.ts names get declarations in dist/_vendor/shared/. Every
//    '@kortix/shared[/…]' / '@kortix/manifest-schema[/…]' specifier in dist/**/*.{js,d.ts}
//    is rewritten to them. A .d.ts may name @kortix/shared types only.
// 5. Guards: no private '@kortix/…' specifier is left, every source 'use client' survives,
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
// Private workspace packages dist must not import (npm cannot install them).
const PRIVATE_PKGS = { '@kortix/shared': 'shared', '@kortix/manifest-schema': 'manifest-schema' };
const SHARED = /(['"])(@kortix\/(?:shared|manifest-schema)(?:\/[\w./-]+)?)\1/g;
const SHARED_ANY = /['"]@kortix\/(?:shared|manifest-schema)(?:\/[\w./-]+)?['"]/;
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
// A component's own stylesheet (`import './x.css'`) ships next to its .js.
for (const css of walk(SRC).filter((p) => p.endsWith('.css') && !p.startsWith(join(SRC, 'styles') + sep))) {
  const out = join(DIST, relative(SRC, css));
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(css, out);
}

// 4. Inline @kortix/shared. The names dist/**/*.js imports from its root or a subpath
// go into one vendor entry, which tsup bundles (tree-shaken) into
// dist/_vendor/kortix-shared.js. The shared modules a .d.ts names get their own
// declarations, emitted by tsc into dist/_vendor/shared/. Then every
// '@kortix/shared[/…]' specifier points at the vendored file.
const SHARED_DIR = join(PKG_DIR, '..', 'shared');
const privateName = (spec) => Object.keys(PRIVATE_PKGS).find((n) => spec === n || spec.startsWith(`${n}/`));
const sharedSource = (spec) => {
  const name = privateName(spec);
  const dir = join(PKG_DIR, '..', PRIVATE_PKGS[name]);
  const exports = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports;
  const target = exports[spec === name ? '.' : `./${spec.slice(name.length + 1)}`];
  if (typeof target !== 'string') fail(`'${spec}' is not an export of ${name}`);
  return join(dir, target);
};
const emitted = walk(DIST).filter((p) => /\.(js|d\.ts)$/.test(p));
const values = new Map(); // name → specifier
const typeSpecs = new Set();
for (const file of emitted) {
  const text = readFileSync(file, 'utf8');
  if (!SHARED_ANY.test(text)) continue;
  const at = posix(relative(PKG_DIR, file));
  if (file.endsWith('.d.ts')) {
    for (const m of text.matchAll(SHARED)) {
      if (privateName(m[2]) !== '@kortix/shared') fail(`${at}: a declaration names '${m[2]}'; only @kortix/shared types can be vendored`);
      typeSpecs.add(m[2]);
    }
    continue;
  }
  if (/import\s*\*\s*as\s+\w+\s+from\s*['"]@kortix\/(?:shared|manifest-schema)|export\s*\*\s*from\s*['"]@kortix\/(?:shared|manifest-schema)/.test(text)) {
    fail(`${at}: only named imports from a private '@kortix/…' package can be inlined`);
  }
  for (const m of text.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*['"](@kortix\/(?:shared|manifest-schema)[^'"]*)['"]/g)) {
    for (const name of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      const prev = values.get(name);
      if (prev && prev !== m[2]) fail(`'${name}' is imported from both '${prev}' and '${m[2]}'`);
      values.set(name, m[2]);
    }
  }
}

const cache = join(PKG_DIR, 'node_modules', '.cache', 'kortix-ui-vendor');
const vendorTypes = join(DIST, '_vendor', 'shared');
if (values.size > 0) {
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  const entry = join(cache, 'kortix-shared.ts');
  const bySpec = new Map();
  for (const [name, spec] of values) bySpec.set(spec, [...(bySpec.get(spec) ?? []), name]);
  writeFileSync(
    entry,
    [...bySpec].sort().map(([spec, names]) => `export { ${names.sort().join(', ')} } from '${spec}';\n`).join(''),
  );
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
    noExternal: [/^@kortix\/(?:shared|manifest-schema)/],
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
            if (errors.length || external || !/[\\/]packages[\\/](?:shared|manifest-schema)[\\/]src[\\/]/.test(path)) return undefined;
            return { path, sideEffects: false };
          });
        },
      },
    ],
  });
}
if (typeSpecs.size > 0) {
  mkdirSync(cache, { recursive: true });
  const tsconfig = join(cache, 'tsconfig.shared-types.json');
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: join(SHARED_DIR, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: join(SHARED_DIR, 'src'),
        outDir: vendorTypes,
      },
      include: [],
      files: [...typeSpecs].map(sharedSource),
    }),
  );
  tsc('tsc', ['-p', tsconfig]);
  tsc('tsc-alias', ['-p', tsconfig, '--resolve-full-paths']);
  // A shared module whose declaration names the NodeJS namespace is server code (for
  // example environment-secret). It leaves the vendored types, so a browser host's
  // typecheck with skipLibCheck: false needs no @types/node.
  for (const dts of walk(vendorTypes).filter((p) => p.endsWith('.d.ts'))) {
    if (!/\bNodeJS\./.test(readFileSync(dts, 'utf8'))) continue;
    const mod = posix(relative(vendorTypes, dts)).replace(/\.d\.ts$/, '');
    for (const index of walk(vendorTypes).filter((p) => p.endsWith('index.d.ts'))) {
      const rel = posix(relative(dirname(index), join(vendorTypes, mod)));
      const spec = rel.startsWith('.') ? rel : `./${rel}`;
      const text = readFileSync(index, 'utf8');
      const kept = text.replace(new RegExp(`^export \\* from ['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js)?['"];?\\n`, 'gm'), '');
      if (kept !== text) writeFileSync(index, kept);
    }
    rmSync(dts);
    rmSync(dts.replace(/\.d\.ts$/, '.d.ts.map'), { force: true });
  }
}
rmSync(cache, { recursive: true, force: true });

const vendor = join(DIST, '_vendor', 'kortix-shared.js');
const relativeTo = (file, target) => {
  const path = posix(relative(dirname(file), target));
  return path.startsWith('.') ? path : `./${path}`;
};
for (const file of emitted) {
  const text = readFileSync(file, 'utf8');
  if (!SHARED_ANY.test(text)) continue;
  const dts = file.endsWith('.d.ts');
  const to = (spec) =>
    dts
      ? relativeTo(file, join(vendorTypes, relative(join(SHARED_DIR, 'src'), sharedSource(spec)).replace(/\.tsx?$/, '.js')))
      : relativeTo(file, vendor);
  writeFileSync(file, text.replace(SHARED, (_, q, spec) => `${q}${to(spec)}${q}`));
}

// 4b. Every dist/internal/**/*.d.ts says it is private, so an editor's hover and
// autocomplete show it next to the name (README "Modules": internal/* has no semver).
const INTERNAL_BANNER = '/** @internal Kortix apps only. No semver: it may change in any release. */\n';
for (const dts of walk(join(DIST, 'internal')).filter((p) => p.endsWith('.d.ts'))) {
  const text = readFileSync(dts, 'utf8');
  if (!text.startsWith(INTERNAL_BANNER)) writeFileSync(dts, INTERNAL_BANNER + text);
}

// 5. Guards.
const leftover = walk(DIST)
  .filter((p) => /\.(js|d\.ts)$/.test(p))
  .filter((p) => /from\s*['"]@kortix\/(?:shared|manifest-schema)|import\(\s*['"]@kortix\/(?:shared|manifest-schema)/.test(readFileSync(p, 'utf8')));
if (leftover.length) fail(`a private '@kortix/…' package is still imported by: ${leftover.map((p) => posix(relative(PKG_DIR, p))).join(', ')}`);

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
  `build: dist/ ${js} .js modules, ${targets.length} export targets present, @kortix/shared + @kortix/manifest-schema inlined (${values.size} values; types of ${typeSpecs.size} modules)`,
);
