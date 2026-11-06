import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedTrigger } from '@kortix/sdk';
import { printRuntimeTriggers } from './triggers-runtime.ts';

const pid = '11111111-1111-4111-8111-111111111111';
const sid = '55555555-5555-4555-8555-555555555555';
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

test('loops ls prints next and last fired as "YYYY-MM-DD HH:MM UTC", and an em dash for a missing instant', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ reminders: [
    { id: 'rem_1', state: 'active', every: '1h', cron: null, timezone: 'UTC', prompt: 'check', name: 'hourly', session_id: sid, next_fire_at: '2026-11-06T12:34:56.000Z', last_fired_at: '2026-11-06T11:34:56.000Z', last_error: null },
    { id: 'rem_2', state: 'done', every: null, cron: null, timezone: 'UTC', prompt: 'once', name: null, session_id: sid, next_fire_at: null, last_fired_at: null, last_error: null },
  ] }) });
  const home = mkdtempSync(join(tmpdir(), 'kortix-loops-'));
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), 'loops', 'ls', '--session', sid], {
      cwd: home, stdout: 'pipe', stderr: 'pipe', env: {
        PATH: process.env.PATH ?? '', HOME: home, CI: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        KORTIX_CONFIG_FILE: join(home, 'config.json'), KORTIX_DEFAULT_API_BASE: base,
        KORTIX_API_URL: `${base}/v1`, KORTIX_TOKEN: 'kortix_pat_synthetic', KORTIX_PROJECT_ID: pid,
        KORTIX_FEATURE_FLAGS: 'reminders',
      },
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(0);
    const rows = plain(stdout).split('\n').filter((line) => line.includes('rem_'));
    expect(rows[0]).toContain('every 1h                  2026-11-06 12:34 UTC  2026-11-06 11:34 UTC  hourly  check');
    expect(rows[1]).toContain('once                      —                     —                     —       once');
  } finally {
    rmSync(home, { recursive: true, force: true });
    server.stop(true);
  }
});

test('triggers ls runtime table prints next and last fired as UTC instants, an em dash for a missing one', () => {
  const trigger = (over: Partial<UnifiedTrigger>): UnifiedTrigger => ({
    id: 'trg_1', origin: 'runtime', name: null, prompt: 'check', agent: 'engineering', state: 'active',
    source: { type: 'schedule', every: '1h' }, target: { kind: 'agent', agent: 'engineering' },
    next_fire_at: '2026-11-06T12:34:56.000Z', last_fired_at: null, last_status: null, last_error: null, ...over,
  });
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    printRuntimeTriggers([trigger({}), trigger({ id: 'trg_2', next_fire_at: null, last_fired_at: '2026-11-05T01:02:03.000Z' })]);
  } finally {
    process.stdout.write = write;
  }
  const rows = plain(chunks.join('')).split('\n').filter((line) => line.includes('trg_'));
  expect(rows[0]).toMatch(/trg_1 .*active {3}2026-11-06 12:34 UTC {2}—$/);
  expect(rows[1]).toMatch(/trg_2 .*active {3}— {21}2026-11-05 01:02 UTC$/);
});
