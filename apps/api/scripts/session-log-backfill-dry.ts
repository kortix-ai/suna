#!/usr/bin/env bun
/**
 * One dry pass of the session-log backfill (P3.1) against the database in `DATABASE_URL`.
 *
 *   cd <repo root> && dotenvx run -f apps/api/.env.dev -- bun apps/api/scripts/session-log-backfill-dry.ts
 *
 * The mode is hard-coded to `dry`: every conversion runs inside a READ ONLY
 * transaction (`writeSessionLogFromMirror`, `session-log-capture.ts`) and writes
 * nothing. The script does not import the bootstrap, so no worker or server starts.
 * Output is counts only: one JSON line per tick, then the summary. No id or content.
 *
 * Refuses a database that is, or may be, prod or staging: it reads
 * `DATABASE_URL` from `.env.prod` and `.env.staging` with `dotenvx get` and
 * refuses when the connection target (host, port, user, database; no password)
 * equals either one, or when it cannot read either file.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const target = (url: string) => {
  const u = new URL(url);
  return [u.hostname, u.port, u.username, u.pathname].join('|');
};

const envDir = resolve(import.meta.dir, '..');
// `dotenvx get` returns an already-set variable over the file value, so ask with it unset.
const { DATABASE_URL: current, ...cleanEnv } = process.env;
for (const name of ['prod', 'staging']) {
  const r = spawnSync('dotenvx', ['get', 'DATABASE_URL', '-f', resolve(envDir, `.env.${name}`)], { encoding: 'utf8', env: cleanEnv });
  const other = r.status === 0 ? r.stdout.trim() : '';
  if (!other) throw new Error(`refusing to run: cannot read DATABASE_URL of ${name} to compare (exit ${r.status})`);
  if (target(other) === target(current ?? 'postgres://invalid@invalid/x')) {
    throw new Error(`refusing to run: DATABASE_URL points at ${name}`);
  }
}

// Dynamic import: nothing from the API (config, db) loads before the check above.
const { backfillSessionLogs, newBackfillState } = await import('../src/projects/session-log-backfill');
const state = newBackfillState('dry');
// A finished pass resets `state.totals`, so the summary folds the per-tick counts itself.
const total: Record<string, number> = {};
let ticks = 0;
for (let more = true; more; ) {
  const r = await backfillSessionLogs('dry', state);
  more = r.more;
  ticks++;
  for (const [k, v] of Object.entries(r.counts)) total[k] = k.startsWith('max_') || k === 'pass_ms' ? Math.max(total[k] ?? 0, v) : (total[k] ?? 0) + v;
  const { sessions, logs, skipped, failed, messages, pass_ms } = r.counts;
  console.log(JSON.stringify({ tick: ticks, sessions, logs, skipped, failed, messages, pass_ms, more }));
}
console.log(JSON.stringify({ summary: true, ticks, ...total }));
process.exit(0);
