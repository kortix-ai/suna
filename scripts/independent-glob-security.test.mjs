import { test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const scanner = createRequire(realpathSync(process.env.SCANNER_MANIFEST || join(import.meta.dir, '../.deepsec/node_modules/deepsec/package.json')));
const daemonManifest = process.env.DAEMON_MANIFEST || join(import.meta.dir, '../apps/kortix-sandbox-agent-server/package.json');
const daemon = createRequire(daemonManifest);
const piRoot = join(daemonManifest, '../node_modules/@earendil-works/pi-coding-agent');
const daemonPi = createRequire(realpathSync(join(piRoot, 'package.json')));

for (const [name, consumer] of [['scanner', scanner], ['daemon pi', daemonPi]]) {
  test(`${name} caps globstar parent amplification`, () => {
    const { Minimatch } = consumer('minimatch');
    const matcher = new Minimatch('**/../a/b/**/../c/d/**/../e/f', { optimizationLevel: 2, braceExpandMax: 2 });
    expect(matcher.globParts.length).toBeLessThanOrEqual(2);
    expect(new Minimatch('**/*.{ts,js}', { dot: true }).match('.hidden/a.ts')).toBe(true);
    expect(new Minimatch('**/*.ts').match('nested/a.js')).toBe(false);
  });
}

test('daemon ESLint flat config includes, excludes and lints matching files', async () => {
  const { ESLint } = daemon('eslint');
  const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.{js,cjs}'], ignores: ['**/skip.js'], rules: { 'no-debugger': 'error' } }] });
  expect((await lint.lintText('debugger;', { filePath: 'nested/a.js' }))[0].messages[0].ruleId).toBe('no-debugger');
  expect((await lint.lintText('debugger;', { filePath: 'nested/skip.js' }))[0].errorCount).toBe(0);
});

test('daemon ESLint ESM legacy overrides retain matcher semantics', async () => {
  const { pathToFileURL } = await import('node:url');
  const path = join(daemon.resolve('@eslint/eslintrc/package.json'), '../lib/config-array/override-tester.js');
  const { OverrideTester } = await import(pathToFileURL(path).href);
  const tester = OverrideTester.create(['**/*.js'], ['**/skip.js'], '/synthetic');
  expect(tester.test('/synthetic/nested/a.js')).toBe(true);
  expect(tester.test('/synthetic/nested/skip.js')).toBe(false);
});

test('scanner glob abort stops directory traversal after rejection', async () => {
  const fs = await import('node:fs');
  const { mkdtempSync, mkdirSync, rmSync } = fs;
  const { tmpdir } = await import('node:os');
  const cwd = mkdtempSync(join(tmpdir(), 'scanner-abort-'));
  const controller = new AbortController();
  let reads = 0;
  try {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) mkdirSync(join(cwd, `d${i}`, `s${j}`), { recursive: true });
    }
    const pi = createRequire(realpathSync(join(scanner.resolve('deepsec'), '../../../@earendil-works/pi-coding-agent/package.json')));
    const { glob } = pi('glob');
    const instrumented = { ...fs, readdir(path, options, callback) {
      reads++;
      if (reads === 1) controller.abort(new Error('synthetic-abort'));
      return fs.readdir(path, options, callback);
    } };
    await expect(glob('**/*', { cwd, fs: instrumented, signal: controller.signal })).rejects.toThrow('synthetic-abort');
    const atReject = reads;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(reads).toBe(atReject);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('daemon pi model scopes keep wildcard and thinking-level behavior', async () => {
  const { pathToFileURL } = await import('node:url');
  const { resolveModelScopeFromModels } = await import(pathToFileURL(join(piRoot, 'dist/core/model-resolver.js')).href);
  const models = [{ provider: 'synthetic', id: 'alpha' }, { provider: 'synthetic', id: 'beta' }];
  const result = resolveModelScopeFromModels(['synthetic/a*:high'], models);
  expect(result.scopedModels).toEqual([{ model: models[0], thinkingLevel: 'high' }]);
  expect(result.diagnostics).toEqual([]);
});

test('scanner CLI scans brace globs and excludes test files', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { spawnSync } = require('node:child_process');
  const cwd = mkdtempSync(join(tmpdir(), 'scanner-cli-'));
  try {
    mkdirSync(join(cwd, 'src'));
    for (const file of ['a.ts', 'b.js', 'skip.test.ts']) writeFileSync(join(cwd, 'src', file), 'synthetic-probe');
    writeFileSync(join(cwd, 'deepsec.config.ts'), `export default {
      projects: [{ id: 'synthetic', root: '.' }],
      plugins: [{ name: 'synthetic', matchers: [{ slug: 'synthetic-probe', description: 'synthetic', noiseTier: 'normal',
        filePatterns: ['src/**/*.{ts,js}'], match(content) { return content.includes('synthetic-probe') ? [{ line: 1, label: 'synthetic', match: 'synthetic-probe' }] : []; }
      }] }]
    };`);
    const result = spawnSync('node', [scanner.resolve('deepsec'), 'scan', '--project-id', 'synthetic', '--matchers', 'synthetic-probe'], { cwd, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2\u001b[0m total matches');
    expect(result.stdout).not.toContain('src/skip.test.ts');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
