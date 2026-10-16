#!/usr/bin/env bun
// `pnpm check` — the agent inner loop. Typechecks every workspace package this
// branch touches (vs `git merge-base origin/dev HEAD`, plus uncommitted and
// untracked files) and lints the touched files of packages that use ESLint.
// Packages run in parallel. `pnpm check apps/api packages/sdk` names them instead.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

type Task = { dir: string; name: string; cmd: string[] };
const tasks: Task[] = dirs.flatMap((dir) => {
  const manifest = join(root, dir, 'package.json');
  if (!existsSync(manifest)) return [];
  const scripts: Record<string, string> = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
  const out: Task[] = [];
  if (scripts.typecheck) out.push({ dir, name: 'typecheck', cmd: ['pnpm', 'run', '--silent', 'typecheck'] });
  const lintable = files.filter((f) => f.startsWith(`${dir}/`) && /\.(ts|tsx|js|mjs)$/.test(f));
  if (scripts.lint?.startsWith('eslint') && lintable.length > 0) {
    const rel = lintable.map((f) => f.slice(dir.length + 1));
    out.push({ dir, name: `lint (${rel.length} files)`, cmd: ['pnpm', 'exec', 'eslint', '--no-warn-ignored', '--quiet', ...rel] });
  }
  return out;
});

if (tasks.length === 0) {
  console.log('check: no touched package has a typecheck or eslint script');
  process.exit(0);
}
const started = Date.now();
const results = await Promise.all(
  tasks.map(async (task) => {
    const t0 = Date.now();
    const proc = Bun.spawn(task.cmd, { cwd: join(root, task.dir), stdout: 'pipe', stderr: 'pipe' });
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    const code = await proc.exited;
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${seconds.padStart(6)}s  ${task.dir} ${task.name}`);
    return { task, code, output };
  }),
);
for (const { task, code, output } of results) {
  if (code !== 0) console.log(`\n── ${task.dir} ${task.name}\n${output.trim()}`);
}
console.log(`\ncheck: ${((Date.now() - started) / 1000).toFixed(1)}s wall, ${results.filter((r) => r.code !== 0).length} failed`);
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
