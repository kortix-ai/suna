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
  rmSync(dir, { recursive: true, force: true });
}

// 2) A declared entrypoint missing from the build output must fail loudly.
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

// 3) Missing VERSION must fail.
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
