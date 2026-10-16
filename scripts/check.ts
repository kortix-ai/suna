#!/usr/bin/env bun
// `pnpm check` — the whole local verification loop. For every workspace package
// this branch touches (vs `git merge-base origin/dev HEAD`, plus uncommitted and
// untracked files) it runs, in parallel:
//   1. the package's `typecheck` script,
//   2. ESLint on the touched files (packages whose `lint` is ESLint),
//   3. ONLY the tests related to the touched files: a touched test file, and for
//      a touched `foo.ts(x)` its `foo.test.ts(x)` / `foo.*.test.ts(x)` siblings and
//      `foo.*` tests in a `__tests__/` beside it or one level up. Never a whole suite.
// `pnpm check apps/api packages/sdk` limits it to those packages. The full suites
// stay in `pnpm test` and CI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const root = join(import.meta.dir, '..');
const git = (...args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd: root }).stdout.toString().split('\n').filter(Boolean);

const base = git('merge-base', 'origin/dev', 'HEAD')[0];
const files = [...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')]
  .filter((file) => existsSync(join(root, file)));
const pkgOf = (file: string) => file.split('/').slice(0, 2).join('/');
const dirs = process.argv.length > 2
  ? process.argv.slice(2).map((dir) => dir.replace(/\/$/, ''))
  : [...new Set(files.filter((f) => /^(apps|packages)\/[^/]+\//.test(f)).map(pkgOf))];

const TEST = /\.test\.(ts|tsx|js|mjs)$/;
// PostgreSQL suites and live-credential tests belong to `pnpm test`'s db-suites lane.
const UNIT = (f: string) => !/(^|\/)integration-|\.integration\.test\.|\.live\.test\./.test(f);
const ls = (dir: string) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((n) => join(dir, n)) : []);

/** Repo-relative test files related to one touched file. */
function relatedTests(file: string): string[] {
  if (TEST.test(file)) return [file];
  if (!/\.(ts|tsx)$/.test(file) || file.endsWith('.d.ts')) return [];
  const stem = basename(file).replace(/\.(ts|tsx)$/, '');
  const dir = dirname(file);
  return [...ls(dir), ...ls(join(dir, '__tests__')), ...ls(join(dirname(dir), '__tests__'))].filter(
    (f) => TEST.test(f) && basename(f).startsWith(`${stem}.`),
  );
}

type Task = { dir: string; name: string; cmd: string[] };
const tasks: Task[] = dirs.flatMap((dir) => {
  const manifest = join(root, dir, 'package.json');
  if (!existsSync(manifest)) return [];
  const scripts: Record<string, string> = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
  const touched = files.filter((f) => f.startsWith(`${dir}/`));
  const rel = (f: string) => `./${f.slice(dir.length + 1)}`;
  const out: Task[] = [];
  if (scripts.typecheck) out.push({ dir, name: 'typecheck', cmd: ['pnpm', 'run', '--silent', 'typecheck'] });
  const lintable = touched.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f)).map(rel);
  if (scripts.lint?.startsWith('eslint') && lintable.length > 0) {
    out.push({ dir, name: `lint (${lintable.length} files)`, cmd: ['pnpm', 'exec', 'eslint', '--no-warn-ignored', '--quiet', ...lintable] });
  }
  const tests = [...new Set(touched.flatMap(relatedTests))].filter((f) => existsSync(join(root, f)) && UNIT(f)).map(rel);
  if (tests.length === 0) {
    console.log(`     -      ${dir} tests: no test file relates to the touched files; none run`);
  } else if (/\bbun test\b|scripts\/test\.sh/.test(scripts.test ?? '')) {
    // The same hermetic env and isolation the package suites use (scripts/test.sh).
    const envFile = existsSync(join(root, dir, 'scripts/test.env')) ? ' --env-file=scripts/test.env' : '';
    const run = `. ../../scripts/hermetic-test-env.sh && exec bun test --isolate --timeout=30000${envFile} "$@"`;
    out.push({ dir, name: `tests: ${tests.join(' ')}`, cmd: ['bash', '-c', run, 'bun-test', ...tests] });
  }
  return out;
});

if (tasks.length === 0) {
  console.log('check: nothing to run for the touched packages');
  process.exit(0);
}
const started = Date.now();
const results = await Promise.all(
  tasks.map(async (task) => {
    const t0 = Date.now();
    const proc = Bun.spawn(task.cmd, { cwd: join(root, task.dir), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${seconds.padStart(6)}s  ${task.dir} ${task.name}`);
    return { task, code, output: out + err };
  }),
);
for (const { task, code, output } of results) {
  if (code !== 0) console.log(`\n── ${task.dir} ${task.name}\n${output.trim()}`);
}
console.log(`\ncheck: ${((Date.now() - started) / 1000).toFixed(1)}s wall, ${results.filter((r) => r.code !== 0).length} failed`);
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
