/**
 * Update notifier + the per-release snooze that backs the interactive
 * "update now?" prompt on bare `kortix`.
 *
 * The rules that matter: never interrupt a non-terminal (scripts, CI, pipes),
 * never ask twice about a release the user already declined, and never let a
 * snooze survive into a NEWER release — that would silently strand someone on
 * an old CLI, which is the failure mode this prompt exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getUpdateNotice,
  isUpdateSnoozed,
  renderUpdateBox,
  resolveUpdateStatus,
  snoozeUpdate,
} from '../update-check.ts';

let dir = '';
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let served: string | null = 'v9.9.9';

/** The cache lives next to the config file, so pointing KORTIX_CONFIG_FILE at a
 *  temp dir isolates both from the developer's real ~/.config/kortix. */
function cacheFile(): string {
  return join(dir, 'update-check.json');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-update-'));
  process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
  delete process.env.KORTIX_NO_UPDATE_CHECK;
  delete process.env.KORTIX_SKIP_UPDATE_CHECK;
  delete process.env.CI;
  // isDisabled() bails on a non-TTY stdout, which is exactly what `bun test`
  // gives us — force it on so the resolution logic is reachable.
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  served = 'v9.9.9';
  globalThis.fetch = (async () =>
    served === null
      ? new Response('nope', { status: 404 })
      : new Response(JSON.stringify({ tag_name: served }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveUpdateStatus', () => {
  test('reports a newer release with both the tag and its display form', async () => {
    const status = await resolveUpdateStatus('0.10.15', { allowFetch: true });
    expect(status).toEqual({ current: '0.10.15', latestTag: 'v9.9.9', latestDisplay: 'v9.9.9' });
  });

  test('is null when already current, and when ahead of the release', async () => {
    served = 'v1.0.0';
    expect(await resolveUpdateStatus('1.0.0', { allowFetch: true })).toBeNull();
    expect(await resolveUpdateStatus('1.0.1', { allowFetch: true })).toBeNull();
  });

  test('is null for a dev build — there is nothing to compare against', async () => {
    expect(await resolveUpdateStatus('dev', { allowFetch: true })).toBeNull();
    expect(await resolveUpdateStatus('0.10.15-dev.abc', { allowFetch: true })).toBeNull();
  });

  test('is null in CI and when explicitly disabled — scripts are never nagged', async () => {
    process.env.CI = '1';
    expect(await resolveUpdateStatus('0.1.0', { allowFetch: true })).toBeNull();
    delete process.env.CI;
    process.env.KORTIX_NO_UPDATE_CHECK = '1';
    expect(await resolveUpdateStatus('0.1.0', { allowFetch: true })).toBeNull();
  });

  test('never throws when the release lookup fails — it just goes quiet', async () => {
    served = null;
    expect(await resolveUpdateStatus('0.1.0', { allowFetch: true })).toBeNull();

    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await resolveUpdateStatus('0.1.0', { allowFetch: true })).toBeNull();
  });

  test('allowFetch:false renders from cache only, never the network', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await resolveUpdateStatus('0.1.0', { allowFetch: false })).toBeNull();
    expect(calls).toBe(0);

    await resolveUpdateStatus('0.1.0', { allowFetch: true }); // warms the cache
    calls = 0;
    const cached = await resolveUpdateStatus('0.1.0', { allowFetch: false });
    expect(cached?.latestTag).toBe('v9.9.9');
    expect(calls).toBe(0);
  });
});

describe('update snooze', () => {
  test('a declined release stops being asked about; a newer one still asks', async () => {
    expect(isUpdateSnoozed('v9.9.9')).toBe(false);

    snoozeUpdate('v9.9.9');

    expect(isUpdateSnoozed('v9.9.9')).toBe(true);
    // The whole point: a snooze must not carry into the NEXT release.
    expect(isUpdateSnoozed('v10.0.0')).toBe(false);
  });

  test('survives a cache refresh — declining must not re-ask every TTL window', async () => {
    await resolveUpdateStatus('0.1.0', { allowFetch: true }); // writes the cache
    snoozeUpdate('v9.9.9');

    // Expire the cache so the next resolve re-fetches and rewrites it.
    const entry = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    writeFileSync(cacheFile(), JSON.stringify({ ...entry, checkedAt: 0 }));

    await resolveUpdateStatus('0.1.0', { allowFetch: true });

    expect(isUpdateSnoozed('v9.9.9')).toBe(true);
  });

  test('a corrupt cache is not fatal — nothing is snoozed', () => {
    writeFileSync(cacheFile(), 'not json');
    expect(isUpdateSnoozed('v9.9.9')).toBe(false);
    snoozeUpdate('v9.9.9');
    expect(isUpdateSnoozed('v9.9.9')).toBe(true);
  });
});

describe('rendering', () => {
  test('the interactive box drops the "run kortix update" advice it is replacing', async () => {
    const status = await resolveUpdateStatus('0.10.15', { allowFetch: true });
    if (!status) throw new Error('expected an available update');

    const passive = renderUpdateBox(status, false);
    const interactive = renderUpdateBox(status, true);

    expect(passive).toContain('kortix update');
    expect(interactive).not.toContain('kortix update');
    // Both still say what you're on and what you'd get.
    for (const box of [passive, interactive]) {
      expect(box).toContain('0.10.15');
      expect(box).toContain('v9.9.9');
    }
  });

  test('the subcommand nudge stays a single line and still points at the command', async () => {
    const line = await getUpdateNotice('0.10.15', { allowFetch: true, style: 'line' });
    expect(line).toContain('kortix update');
    expect(line?.includes('\n')).toBe(false);
  });
});
