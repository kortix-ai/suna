#!/usr/bin/env bun
import { readFile, rm } from 'node:fs/promises';
import { portInUse } from '../../scripts/worktree/lib/exec';
import { ensureLocalSupabase, resolveLocalTopology } from '../src/core/local-stack';

const topology = resolveLocalTopology(process.cwd());
const args = process.argv.slice(2);
if (args.some((arg) => arg === '--output' || arg.startsWith('--output='))) {
  throw new Error('agentic tests require the configured .e2e report directory');
}
for (const port of [
  topology.marker?.ports.web ?? 3000,
  topology.marker?.ports.api ?? 8008,
  topology.marker?.ports.gateway ?? 8090,
]) {
  const listener = portInUse(port);
  if (!listener.pid) continue;
  const cwd = Bun.spawnSync(['lsof', '-a', '-p', listener.pid, '-d', 'cwd', '-Fn'])
    .stdout.toString()
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  if (!cwd || (cwd !== topology.root && !cwd.startsWith(`${topology.root}/`))) {
    throw new Error(
      `port ${port} belongs to another checkout; reassign this worktree before starting tests`,
    );
  }
}
const localSupabase = await ensureLocalSupabase(topology, { autoStart: true });
const supabase = localSupabase.environment;
await rm('.e2e/report.json', { force: true });

// Keep the pilot inside pnpm test. e2e's exit 0 also accepts skipped and flaky tests.
const child = Bun.spawn(['pnpm', 'exec', 'e2e', 'run', ...args], {
  env: {
    ...process.env,
    E2E_TELEMETRY_DISABLED: '1',
    E2E_SUPABASE_URL: supabase.API_URL,
    E2E_DATABASE_URL: supabase.DB_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabase.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await child.exited.finally(() =>
  localSupabase.started ? localSupabase.stop() : undefined,
);
if (exitCode !== 0) process.exit(exitCode);

const report = JSON.parse(await readFile('.e2e/report.json', 'utf8'));
const selected = report.run.results.filter((result: { selected: boolean }) => result.selected);
const incomplete = selected.filter((result: { status: string }) => result.status !== 'passed');
if (selected.length === 0 || incomplete.length > 0 || report.run.errors.length > 0) {
  console.error(
    `[agentic] FAIL: ${selected.length} selected, ${incomplete.length} incomplete, ${report.run.errors.length} run errors`,
  );
  process.exit(1);
}
console.log(`[agentic] PASS: ${selected.length} selected, 0 skipped, 0 flaky`);
