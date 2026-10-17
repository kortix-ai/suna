/**
 * Rebuild one target's table in e2e/shard-durations.json from CI job logs.
 *
 *   bun tests/bin/refresh-shard-durations.ts <local|deployed> <run-id>...
 *
 * `local` reads the `browser-N lane` jobs of tests.yml runs. `deployed` reads
 * the `deployed browser shard` jobs of tests-release.yml runs. The Playwright
 * list reporter prints `(8.4s)` per attempt; the table holds, per spec file,
 * the median over runs of that file's summed attempt seconds. A spec file that
 * no run executed gets 0. Needs `gh`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { listSpecFiles } from '../src/core/browser-shard';

const TABLE = resolve(import.meta.dirname, '../e2e/shard-durations.json');
const JOB_NAME = { local: /^browser-\d+ lane$/, deployed: /deployed browser shard/ };
const LINE = /\[chromium\] › (e2e\/specs\/[^:]+\.spec\.ts):\d+:\d+ › .*\((\d+(?:\.\d+)?)(ms|s|m)\)(?: \(retry #\d+\))?\s*$/;
const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60 } as const;

export function parseSpecSeconds(log: string): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const line of log.split('\n')) {
    const m = LINE.exec(line);
    if (m) totals[m[1]!] = (totals[m[1]!] ?? 0) + Number(m[2]) * UNIT_SECONDS[m[3] as 'ms' | 's' | 'm'];
  }
  return totals;
}

export function medianTable(perRun: Record<string, number>[]): Record<string, number> {
  const bySpec: Record<string, number[]> = {};
  for (const run of perRun) for (const [spec, s] of Object.entries(run)) (bySpec[spec] ??= []).push(s);
  const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1]!;
  return Object.fromEntries(
    Object.keys(bySpec).sort().map((spec) => [spec, Math.round(median(bySpec[spec]!) * 10) / 10]),
  );
}

function gh(...args: string[]): string {
  const p = Bun.spawnSync(['gh', ...args, '--repo', 'kortix-ai/suna'], { stderr: 'inherit' });
  if (p.exitCode !== 0) throw new Error(`gh ${args.join(' ')} failed`);
  return p.stdout.toString();
}

if (import.meta.main) {
  const [target, ...runs] = process.argv.slice(2);
  if ((target !== 'local' && target !== 'deployed') || runs.length === 0) {
    throw new Error('usage: refresh-shard-durations.ts <local|deployed> <run-id>...');
  }
  const perRun = runs.map((run) => {
    try {
      return runSeconds(target, run);
    } catch (error) {
      console.error(`skip run ${run}: ${error instanceof Error ? error.message : error}`);
      return {};
    }
  }).filter((r) => Object.keys(r).length > 0);
  if (perRun.length === 0) throw new Error('no usable run');
  const table = JSON.parse(readFileSync(TABLE, 'utf8'));
  // A spec on disk that no green run executed was excluded at collection
  // (@local-only, a disabled capability): it costs nothing.
  table[target] = { ...Object.fromEntries(listSpecFiles().map((spec) => [spec, 0])), ...medianTable(perRun) };
  writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`${target}: ${Object.keys(table[target]).length} specs from ${perRun.length} runs`);
}

function runSeconds(target: 'local' | 'deployed', run: string): Record<string, number> {
  const jobs: { databaseId: number; name: string; conclusion: string }[] = JSON.parse(
    gh('run', 'view', run, '--json', 'jobs'),
  ).jobs;
  const merged: Record<string, number> = {};
  // A run only counts when every browser shard passed: a failed or cancelled
  // shard logs a partial file list and would drag its specs' medians down.
  const browser = jobs.filter((j) => JOB_NAME[target].test(j.name));
  if (browser.length === 0 || browser.some((j) => j.conclusion !== 'success')) {
    console.error(`skip run ${run}: browser jobs missing or not all green`);
    return merged;
  }
  for (const job of browser) {
    Object.assign(merged, parseSpecSeconds(gh('run', 'view', '--job', String(job.databaseId), '--log')));
  }
  return merged;
}
