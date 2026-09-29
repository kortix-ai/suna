/**
 * The box is the authority on its own identity key.
 *
 * `KORTIX_TOKEN` is set in the PROVIDER's env at sandbox-create time, and
 * Platinum exposes no env-update endpoint — only `exec`. So that value is
 * immutable for the life of the box and is re-asserted on every start. The
 * legacy repair nevertheless rotates the key: it writes a new PAT to
 * `/etc/environment`, probes the RUNNING daemon (which passes, it was handed
 * the value), and commits it to the row. The box then restarts, the provider
 * re-injects the ORIGINAL token, and the row and the box disagree forever.
 *
 * Measured on dev 2026-09-28: every session in the dominant failure class
 * returned `401 {"error":"unauthorized","reason":"bad_signature"}` with a
 * `kortix_pat_…` key on the row, and one box that restarted at 16:14 — long
 * after its 06:58 rotation — still failed at 17:01. A completely healthy box
 * (`daemon: ok`, `opencode: ok`, `runtimeReady: true`) permanently unusable.
 */

import { describe, expect, test } from 'bun:test';

import {
  isPlausibleServiceKey,
  reconcileServiceKeyFromBox,
  type ServiceKeyReconcileDeps,
} from './service-key-reconcile';

const BOX_KEY = 'kortix_sb_originalcreatetimetoken0000';
const ROW_KEY = 'kortix_pat_rotatedbutneverreachedthebox';

function deps(over: Partial<ServiceKeyReconcileDeps> & { written?: string[] } = {}) {
  const written: string[] = over.written ?? [];
  const base: ServiceKeyReconcileDeps = {
    exec: async () => ({ stdout: `${BOX_KEY}\n`, exitCode: 0 }),
    readRow: async () => ({ externalId: 'sbx_1', serviceKey: ROW_KEY, provider: 'platinum' }),
    writeKey: async (_id, key) => {
      written.push(key);
    },
    ...over,
  };
  return { deps: base, written };
}

describe('reconcileServiceKeyFromBox', () => {
  test('corrects a row that disagrees with the box', async () => {
    const { deps: d, written } = deps();
    expect(await reconcileServiceKeyFromBox('sb-1', d)).toBe('reconciled');
    // The BOX's key wins — the provider re-asserts it on every start, so the
    // row is the copy and the box is the original.
    expect(written).toEqual([BOX_KEY]);
  });

  test('writes nothing when they already agree', async () => {
    const { deps: d, written } = deps({
      readRow: async () => ({ externalId: 'sbx_1', serviceKey: BOX_KEY, provider: 'platinum' }),
    });
    expect(await reconcileServiceKeyFromBox('sb-1', d)).toBe('in-sync');
    expect(written).toEqual([]);
  });

  test('NEVER writes an implausible value — that would lock the session out itself', async () => {
    // A shell error on stdout must not become the row's identity key. This is
    // the failure mode being fixed, so causing it here would be unforgivable.
    for (const bad of ['', '   ', 'sh: 1: pgrep: not found', 'kortix_', 'no-prefix-at-all']) {
      const { deps: d, written } = deps({ exec: async () => ({ stdout: bad, exitCode: 0 }) });
      const outcome = await reconcileServiceKeyFromBox('sb-1', d);
      expect(outcome === 'unreadable' || outcome === 'rejected').toBe(true);
      expect(written).toEqual([]);
    }
  });

  test('never throws when exec fails — an open is never broken by a reconcile', async () => {
    const { deps: d, written } = deps({
      exec: async () => {
        throw new Error('provider has no exec channel');
      },
    });
    expect(await reconcileServiceKeyFromBox('sb-1', d)).toBe('unreadable');
    expect(written).toEqual([]);
  });

  test('a box with no row, or no external id, is left alone', async () => {
    const { deps: a } = deps({ readRow: async () => null });
    expect(await reconcileServiceKeyFromBox('sb-1', a)).toBe('unreadable');
    const { deps: b } = deps({
      readRow: async () => ({ externalId: null, serviceKey: ROW_KEY, provider: 'platinum' }),
    });
    expect(await reconcileServiceKeyFromBox('sb-1', b)).toBe('unreadable');
  });

  test('reads the LIVE daemon env, not /etc/environment', async () => {
    // `/etc/environment` is precisely the file the rotation wrote and the
    // provider then overrode — reading it would report the key the box is NOT
    // using, which is the same bug in the opposite direction.
    let command: string[] = [];
    const { deps: d } = deps({
      exec: async (_ext, cmd) => {
        command = cmd;
        return { stdout: BOX_KEY, exitCode: 0 };
      },
    });
    await reconcileServiceKeyFromBox('sb-1', d);
    const joined = command.join(' ');
    expect(joined).toContain('/proc/');
    expect(joined).toContain('environ');
    expect(joined).not.toContain('/etc/environment');
  });

  test('falls back to a full-cmdline match for a supervised daemon', async () => {
    // `pgrep -x kortix-agent` only matches the baked daemon's comm name. A box
    // the legacy repair supervised runs the daemon from
    // /opt/kortix/agent.{current,prev,next}, whose comm name it never matches
    // — so every reconcile on such a box returned a silent `unreadable`, the
    // row was never corrected, and the session looped on bad_signature (the
    // 2026-09-29 prod warn spike). The probe must fall back to the same
    // full-cmdline match the bootstrap's own stop path uses.
    let command: string[] = [];
    const { deps: d } = deps({
      exec: async (_ext, cmd) => {
        command = cmd;
        return { stdout: BOX_KEY, exitCode: 0 };
      },
    });
    expect(await reconcileServiceKeyFromBox('sb-1', d)).toBe('reconciled');
    const joined = command.join(' ');
    expect(joined).toContain(
      "pgrep -f '/usr/local/bin/kortix-age[n]t|/opt/kortix/agent[.](current|prev|next)'",
    );
    // The bracket escapes keep the pattern from matching the `sh -lc` wrapper
    // that carries it — a self-match would read the wrong /proc/<pid>/environ.
    expect(joined).toContain('kortix-age[n]t');
  });

  test('an empty report stays unreadable even when the box explains why', async () => {
    const { deps: d, written } = deps({
      exec: async () => ({ stdout: '', stderr: 'no process found', exitCode: 3 }),
    });
    expect(await reconcileServiceKeyFromBox('sb-1', d)).toBe('unreadable');
    expect(written).toEqual([]);
  });
});

describe('isPlausibleServiceKey', () => {
  test('accepts a real key shape', () => {
    expect(isPlausibleServiceKey(BOX_KEY)).toBe(true);
    expect(isPlausibleServiceKey(ROW_KEY)).toBe(true);
  });

  test('rejects anything that is not one', () => {
    for (const bad of ['', 'short', 'kortix_with space inside it here', 'x'.repeat(50_000), 'pat_wrongprefix_aaaaaaaaaaaa']) {
      expect(isPlausibleServiceKey(bad)).toBe(false);
    }
  });
});
