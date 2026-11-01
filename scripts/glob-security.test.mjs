import { test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootRequire = createRequire(import.meta.url);
const migrationRequire = createRequire(rootRequire.resolve('node-pg-migrate'));
const glob = migrationRequire('glob');

test('migration file discovery uses patched glob and minimatch releases', () => {
  expect(Number(migrationRequire('glob/package.json').version.split('.')[0])).toBeGreaterThanOrEqual(14);
  const globRequire = createRequire(migrationRequire.resolve('glob'));
  expect(Number(globRequire('minimatch/package.json').version.split('.')[0])).toBeGreaterThanOrEqual(11);
});

test('migration glob preserves async, sync, ignore, braces, and dotfile discovery', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kortix-glob-'));
  try {
    mkdirSync(join(cwd, 'nested'));
    for (const file of ['001.sql', '002.js', '.hidden.sql', 'nested/003.sql', 'nested/skip.sql', 'note.txt']) {
      writeFileSync(join(cwd, file), '');
    }
    const options = { cwd, dot: true, ignore: ['**/skip.sql'] };
    const expected = ['.hidden.sql', '001.sql', '002.js', 'nested/003.sql'];
    expect((await glob.glob('**/*.{sql,js}', options)).sort()).toEqual(expected);
    expect(glob.globSync('**/*.{sql,js}', options).sort()).toEqual(expected);
    expect(glob.hasMagic('**/*.sql')).toBe(true);
    expect(glob.hasMagic('001.sql')).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('legacy archive unpacking preserves its filesystem behavior', async () => {
  const desktopRequire = createRequire(join(import.meta.dir, '../apps/desktop-electron/package.json'));
  const builderRequire = createRequire(createRequire(desktopRequire.resolve('electron-builder')).resolve('app-builder-lib'));
  const asar = builderRequire('@electron/asar');
  const cwd = mkdtempSync(join(tmpdir(), 'kortix-archive-'));
  try {
    const source = join(cwd, 'source');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'nested/native.node'), 'synthetic');
    writeFileSync(join(source, 'index.js'), 'synthetic');
    const archive = join(cwd, 'app.asar');
    await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });
    expect(asar.listPackage(archive).sort()).toEqual(['/index.js', '/nested', '/nested/native.node']);
    expect(asar.statFile(archive, 'nested/native.node').unpacked).toBe(true);
    expect(asar.extractFile(archive, 'index.js').toString()).toBe('synthetic');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('legacy rimraf callback and sync globs delete only matching files', async () => {
  const { readdirSync } = await import('node:fs');
  const pnpm = join(import.meta.dir, '../node_modules/.pnpm');
  const entry = readdirSync(pnpm).find(name => name.startsWith('rimraf@2.6.3'));
  const rimraf = rootRequire(join(pnpm, entry, 'node_modules/rimraf'));
  const cwd = mkdtempSync(join(tmpdir(), 'kortix-rimraf-'));
  try {
    for (const file of ['one.tmp', 'two.tmp', 'keep.txt']) writeFileSync(join(cwd, file), '');
    await new Promise((resolve, reject) => rimraf(join(cwd, '*.tmp'), error => error ? reject(error) : resolve()));
    expect(readdirSync(cwd)).toEqual(['keep.txt']);
    rimraf.sync(join(cwd, '*.txt'));
    expect(readdirSync(cwd)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('import rule still enforces makeRe-based internal module restrictions', async () => {
  const { ESLint } = await import('eslint');
  const webRequire = createRequire(join(import.meta.dir, '../apps/web/package.json'));
  const plugin = webRequire('eslint-plugin-import');
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
    plugins: { import: plugin },
    rules: { 'import/no-internal-modules': ['error', { forbid: ['synthetic/private/**'] }] },
  }] });
  const [blocked] = await eslint.lintText("import value from 'synthetic/private/secret';", { filePath: 'probe.js' });
  const [allowed] = await eslint.lintText("import value from 'synthetic/public';", { filePath: 'probe.js' });
  expect(blocked.messages.map(message => message.ruleId)).toEqual(['import/no-internal-modules']);
  expect(allowed.messages).toEqual([]);
});

test('Electron builder file filters keep include and exclude behavior', () => {
  const desktopRequire = createRequire(join(import.meta.dir, '../apps/desktop-electron/package.json'));
  const builderRequire = createRequire(createRequire(desktopRequire.resolve('electron-builder')).resolve('app-builder-lib'));
  const { Minimatch } = builderRequire('minimatch');
  const { createFilter } = builderRequire('app-builder-lib/out/util/filter.js');
  const filter = createFilter('/synthetic', [new Minimatch('**/*.js')]);
  expect(filter('/synthetic/src/a.js', { isDirectory: () => false })).toBe(true);
  expect(filter('/synthetic/src/a.ts', { isDirectory: () => false })).toBe(false);
});
