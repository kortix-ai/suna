#!/usr/bin/env bun
/**
 * One dry pass of the session-log backfill (P3.1, P3.2) against the database in `DATABASE_URL`.
 *
 *   cd <repo root> && dotenvx run -f apps/api/.env.dev -- bun apps/api/scripts/session-log-backfill-dry.ts
 *
 * The mode is hard-coded to `dry`: every conversion runs inside a READ ONLY
 * transaction (`writeSessionLogFromMirror`, `session-log-capture.ts`) and writes
 * nothing. The script does not import the bootstrap, so no worker or server starts.
 * Output is counts only: one JSON line per tick, then the summary. No id or content.
 * The API config adds its start-up banner first (variable names and counts, no values).
 * The summary holds the P3.2 checks: `validation_failed`, `roundtrip_mismatch_sessions`
 * and `roundtrip_mismatch_messages` (`session-log-backfill.ts`).
 *
 * Before the API modules load, the script removes every `BETTERSTACK_*` and `OTEL_*`
 * variable (the logger, Sentry and OpenTelemetry sinks read them), so nothing ships to
 * a remote log stream, and sets `LOG_LEVEL=error`: the API's own info, warn and debug
 * lines (some carry a session id) do not print.
 *
 * Refuses a database that is, or may be, prod or staging: it reads `DATABASE_URL`
 * from `.env.prod` and `.env.staging` with `dotenvx get` and refuses when the
 * lowercased hostname equals either one, when a hostname is empty or a URL does not
 * parse, or when it cannot read either file. No refusal message holds any part of a URL.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const refuse = (why: string): never => {
  console.error(`refusing to run: ${why}`);
  process.exit(2);
};
const hostOf = (url: string | undefined, name: string): string => {
  let host = '';
  try {
    host = new URL(url ?? '').hostname.toLowerCase();
  } catch {
    // `new URL` puts its input, password included, in the error: never print it.
    refuse(`DATABASE_URL of ${name} does not parse as a URL`);
  }
  // An empty host lets postgres.js fall back to PGHOST.
  return host || refuse(`DATABASE_URL of ${name} has no hostname`);
};

const envDir = resolve(import.meta.dir, '..');
// `dotenvx get` returns an already-set variable over the file value, so ask with it unset.
const { DATABASE_URL: current, ...cleanEnv } = process.env;
const host = hostOf(current, 'this run');
for (const name of ['prod', 'staging']) {
  const r = spawnSync('dotenvx', ['get', 'DATABASE_URL', '-f', resolve(envDir, `.env.${name}`)], { encoding: 'utf8', env: cleanEnv });
  const other = r.status === 0 ? r.stdout.trim() : '';
  if (!other) refuse(`cannot read DATABASE_URL of ${name} to compare (exit ${r.status})`);
  if (hostOf(other, name) === host) refuse(`DATABASE_URL points at the ${name} host`);
}

for (const key of Object.keys(process.env)) if (key.startsWith('BETTERSTACK_') || key.startsWith('OTEL_')) delete process.env[key];
process.env.LOG_LEVEL = 'error';

// Dynamic import: nothing from the API (config, db, logger) loads before the lines above.
const { backfillSessionLogs, newBackfillState } = await import('../src/projects/session-log-backfill');
const state = newBackfillState('dry');
// A finished pass resets `state.totals`, so the summary folds the per-tick counts itself.
const total: Record<string, number> = {};
let ticks = 0;
for (let more = true; more; ) {
  const r = await backfillSessionLogs('dry', { state });
  more = r.more;
  ticks++;
  for (const [k, v] of Object.entries(r.counts)) total[k] = k.startsWith('max_') || k === 'pass_ms' ? Math.max(total[k] ?? 0, v) : (total[k] ?? 0) + v;
  const { sessions, logs, skipped, failed, validation_failed, roundtrip_mismatch_sessions, messages, pass_ms } = r.counts;
  console.log(JSON.stringify({ tick: ticks, sessions, logs, skipped, failed, validation_failed, roundtrip_mismatch_sessions, messages, pass_ms, more }));
}
console.log(JSON.stringify({ summary: true, ticks, ...total }));
process.exit(0);
