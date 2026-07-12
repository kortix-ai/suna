// Unit tests for scripts/stage-npm-publish.mjs.
// Run: node scripts/stage-npm-publish.test.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const script = fileURLToPath(new URL('./stage-npm-publish.mjs', import.meta.url));
let passed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
};
const run = (dir, version) =>
  execFileSync('node', [script], { cwd: dir, env: { ...process.env, VERSION: version }, encoding: 'utf8' });

// 1) Happy path: promote publishConfig onto top-level, pin the workspace dep to
//    the release version, lock the version, leave registry ranges alone.
{
  const dir = mkdtempSync(join(tmpdir(), 'stage-ok-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  writeFileSync(join(dir, 'dist', 'index.d.ts'), '');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@kortix/x',
        version: '1.0.0',
        main: './src/index.ts',
        types: './src/index.ts',
        exports: { '.': './src/index.ts' },
        dependencies: { '@kortix/shared': 'workspace:*', zustand: '^5.0.3' },
        files: ['dist', 'src', 'README.md'],
        publishConfig: {
          access: 'public',
          type: 'module',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
          files: ['dist', 'README.md'],
        },
      },
      null,
      2,
    ),
  );
  run(dir, '2.3.4');
  const out = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert(out.version === '2.3.4', 'version locked to the release version');
  assert(out.type === 'module', 'type promoted from publishConfig');
  assert(out.main === './dist/index.js', 'main promoted to dist');
  assert(out.types === './dist/index.d.ts', 'types promoted to dist');
  assert(out.exports['.'].import === './dist/index.js', 'exports promoted to dist');
  assert(JSON.stringify(out.files) === JSON.stringify(['dist', 'README.md']), 'files promoted from publishConfig');
  assert(out.dependencies['@kortix/shared'] === '2.3.4', 'workspace dep pinned to the release version');
  assert(out.dependencies.zustand === '^5.0.3', 'registry dep range left untouched');
  assert(out.publishConfig.main === undefined, 'promoted publishConfig overrides stripped');
  assert(out.publishConfig.exports === undefined, 'promoted publishConfig.exports stripped');
  assert(out.publishConfig.access === 'public', 'non-promoted publishConfig (access) kept');
  // A package whose publishConfig carries no CDN fields (llm-catalog,
  // executor-sdk) must stage exactly as before — the CDN promotion is
  // if-present, never assumed.
  assert(out.browser === undefined, 'no top-level browser field when publishConfig has none');
  assert(out.unpkg === undefined, 'no top-level unpkg field when publishConfig has none');
  assert(out.jsdelivr === undefined, 'no top-level jsdelivr field when publishConfig has none');
  rmSync(dir, { recursive: true, force: true });
}

// 2) A package whose publishConfig carries browser/unpkg/jsdelivr (the CDN
//    fields npm/unpkg/jsDelivr read from the top-level manifest, e.g.
//    @kortix/sdk) must have all three promoted to the top level, and the
//    publishConfig overrides stripped like every other promoted field.
{
  const dir = mkdtempSync(join(tmpdir(), 'stage-cdn-ok-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  writeFileSync(join(dir, 'dist', 'index.d.ts'), '');
  writeFileSync(join(dir, 'dist', 'kortix.esm.min.js'), '');
  writeFileSync(join(dir, 'dist', 'kortix.global.js'), '');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@kortix/cdn-ok',
        version: '1.0.0',
        main: './src/index.ts',
        types: './src/index.ts',
        exports: { '.': './src/index.ts' },
        publishConfig: {
          access: 'public',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
          browser: './dist/kortix.esm.min.js',
          unpkg: './dist/kortix.global.js',
          jsdelivr: './dist/kortix.global.js',
          files: ['dist', 'README.md'],
        },
      },
      null,
      2,
    ),
  );
  run(dir, '3.0.0');
  const out = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert(out.browser === './dist/kortix.esm.min.js', 'browser promoted from publishConfig');
  assert(out.unpkg === './dist/kortix.global.js', 'unpkg promoted from publishConfig');
  assert(out.jsdelivr === './dist/kortix.global.js', 'jsdelivr promoted from publishConfig');
  assert(out.publishConfig.browser === undefined, 'promoted publishConfig.browser stripped');
  assert(out.publishConfig.unpkg === undefined, 'promoted publishConfig.unpkg stripped');
  assert(out.publishConfig.jsdelivr === undefined, 'promoted publishConfig.jsdelivr stripped');
  assert(out.publishConfig.access === 'public', 'non-promoted publishConfig (access) kept');
  rmSync(dir, { recursive: true, force: true });
}

// 3) A promoted CDN field pointing at a dist/ path the build never emitted
//    must fail the stage just as loudly as a missing main/types/exports
//    target — otherwise a broken unpkg/jsdelivr link ships silently.
{
  const dir = mkdtempSync(join(tmpdir(), 'stage-cdn-miss-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  // note: no dist/kortix.global.js emitted
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@kortix/cdn-miss',
        version: '1.0.0',
        publishConfig: {
          access: 'public',
          main: './dist/index.js',
          exports: { '.': { import: './dist/index.js' } },
          unpkg: './dist/kortix.global.js',
        },
      },
      null,
      2,
    ),
  );
  let threw = false;
  try {
    run(dir, '1.0.0');
  } catch {
    threw = true;
  }
  assert(threw, 'missing CDN entrypoint (unpkg) must fail the stage');
  rmSync(dir, { recursive: true, force: true });
}

// 4) A declared entrypoint missing from the build output must fail loudly.
{
  const dir = mkdtempSync(join(tmpdir(), 'stage-miss-'));
  mkdirSync(join(dir, 'dist')); // note: no dist/index.js emitted
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@kortix/y',
        version: '1.0.0',
        publishConfig: { access: 'public', main: './dist/index.js', exports: { '.': { import: './dist/index.js' } } },
      },
      null,
      2,
    ),
  );
  let threw = false;
  try {
    run(dir, '1.0.0');
  } catch {
    threw = true;
  }
  assert(threw, 'missing dist entrypoint must fail the stage');
  rmSync(dir, { recursive: true, force: true });
}

// 5) Missing VERSION must fail.
{
  const dir = mkdtempSync(join(tmpdir(), 'stage-nov-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@kortix/z', version: '1.0.0' }, null, 2));
  let threw = false;
  try {
    execFileSync('node', [script], { cwd: dir, env: { ...process.env, VERSION: '' }, encoding: 'utf8' });
  } catch {
    threw = true;
  }
  assert(threw, 'missing VERSION must fail');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`stage-npm-publish.test: ${passed} assertions passed`);
