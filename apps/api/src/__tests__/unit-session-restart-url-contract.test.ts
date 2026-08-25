import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  prepareInPlaceRestartMetadata,
  opencodeReadyWaitPatch,
  staleOpencodeReadyReason,
} from '../projects/session-lifecycle/readiness-clocks';

const source = readFileSync(
  new URL('../projects/session-lifecycle/actions.ts', import.meta.url),
  'utf8',
);

describe('session restart URL contract', () => {
  test('clears sandboxUrl only when a replacement runtime is required', () => {
    const replacementStart = source.indexOf('const provisionReplacementRuntime');
    const inPlaceStart = source.indexOf('if (\n    existingSandbox?.externalId');

    expect(replacementStart).toBeGreaterThan(-1);
    expect(inPlaceStart).toBeGreaterThan(replacementStart);
    expect(source.slice(replacementStart, inPlaceStart)).toContain('sandboxUrl: null');
    expect(source.slice(inPlaceStart)).not.toContain('sandboxUrl: null');
  });

  test('starts a fresh runtime clock and removes stale OpenCode clocks', () => {
    const now = new Date('2026-07-24T02:00:00.000Z');
    const metadata = prepareInPlaceRestartMetadata(
      {
        initSucceededAt: '2026-07-24T01:00:00.000Z',
        opencodeReadyWaitStartedAt: '2026-07-24T01:00:00.000Z',
        opencodeReadyWaitReason: 'unreachable',
        opencodeUnreachableWaitStartedAt: '2026-07-24T01:00:00.000Z',
        opencodeNotReadyWaitStartedAt: '2026-07-24T01:30:00.000Z',
      },
      now,
    );

    expect(metadata.runtimeWakeStartedAt).toBe(now.toISOString());
    expect(metadata.runtimeWakeProviderStatus).toBe('starting');
    expect(metadata.opencodeReadyWaitStartedAt).toBeUndefined();
    expect(metadata.opencodeReadyWaitReason).toBeUndefined();
    expect(metadata.opencodeUnreachableWaitStartedAt).toBeUndefined();
    expect(metadata.opencodeNotReadyWaitStartedAt).toBeUndefined();
  });

  test('tracks unreachable and not-ready deadlines independently across reason changes', () => {
    const metadata = {
      opencodeReadyWaitStartedAt: '2026-07-24T01:59:59.000Z',
      opencodeReadyWaitReason: 'not_ready',
      opencodeUnreachableWaitStartedAt: '2026-07-24T01:59:29.000Z',
      opencodeNotReadyWaitStartedAt: '2026-07-24T01:58:29.000Z',
    };
    const now = Date.parse('2026-07-24T02:00:00.000Z');

    expect(staleOpencodeReadyReason(metadata, 'unreachable', now, 30_000)).toBe(
      'runtime_unreachable_timeout',
    );
    expect(staleOpencodeReadyReason(metadata, 'not_ready', now, 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('does not treat an old initial boot as a stale post-restart OpenCode wait', () => {
    expect(
      staleOpencodeReadyReason(
        { initSucceededAt: '2026-07-24T01:00:00.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBeNull();

    expect(
      staleOpencodeReadyReason(
        { opencodeReadyWaitStartedAt: '2026-07-24T01:54:59.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBe('runtime_unreachable_timeout');
  });
});

describe('progress-aware OpenCode boot budget (Essentia 2026-08-25 17:23 double runtime_boot_failed)', () => {
  const t0 = new Date('2026-08-25T17:23:04.000Z');

  test('a phase change restarts the reason clock; the first-seen clock never moves', () => {
    const first = opencodeReadyWaitPatch({}, 'not_ready', 'config-deps|opencode=starting', t0)!;
    expect(first.opencodeBootWaitFirstSeenAt).toBe(t0.toISOString());
    expect(first.opencodeNotReadyWaitStartedAt).toBe(t0.toISOString());
    expect(first.opencodeBootPhase).toBe('config-deps|opencode=starting');

    // Same phase 60 s later: nothing to write.
    const t1 = new Date(t0.getTime() + 60_000);
    expect(opencodeReadyWaitPatch(first, 'not_ready', 'config-deps|opencode=starting', t1)).toBeNull();

    // New phase 80 s later (install finished, OpenCode spawned): clock restarts.
    const t2 = new Date(t0.getTime() + 80_000);
    const second = opencodeReadyWaitPatch(first, 'not_ready', 'opencode-spawned|opencode=starting', t2)!;
    expect(second.opencodeNotReadyWaitStartedAt).toBe(t2.toISOString());
    expect(second.opencodeBootWaitFirstSeenAt).toBe(t0.toISOString());

    // 85 s after the FIRST poll the old rule parked the box; with progress it is not stale.
    const t3 = new Date(t0.getTime() + 85_000);
    expect(staleOpencodeReadyReason(second, 'not_ready', t3.getTime(), 90_000)).toBeNull();
    // ...but 90 s of NO progress after the last phase change still is.
    const t4 = new Date(t2.getTime() + 90_001);
    expect(staleOpencodeReadyReason(second, 'not_ready', t4.getTime(), 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('a legacy row (single clock + reason) counts as a running clock for that reason', () => {
    const legacy = {
      opencodeReadyWaitStartedAt: '2026-08-25T17:23:04.000Z',
      opencodeReadyWaitReason: 'unreachable',
    };
    expect(opencodeReadyWaitPatch(legacy, 'unreachable', undefined, new Date(t0.getTime() + 31_000))).toBeNull();
    expect(staleOpencodeReadyReason(legacy, 'unreachable', t0.getTime() + 31_000, 30_000)).toBe(
      'runtime_unreachable_timeout',
    );
  });

  test('a daemon that reports no phase keeps the old fixed budget', () => {
    const first = opencodeReadyWaitPatch({}, 'not_ready', undefined, t0)!;
    expect(first.opencodeBootPhase).toBeUndefined();
    expect(opencodeReadyWaitPatch(first, 'not_ready', undefined, new Date(t0.getTime() + 80_000))).toBeNull();
    expect(
      staleOpencodeReadyReason(first, 'not_ready', t0.getTime() + 90_001, 90_000),
    ).toBe('runtime_not_ready_timeout');
  });

  test('the hard cap bounds a boot that keeps changing phase without ever becoming ready', () => {
    let metadata = opencodeReadyWaitPatch({}, 'not_ready', 'p0', t0)!;
    for (let i = 1; i <= 12; i += 1) {
      const t = new Date(t0.getTime() + i * 60_000);
      metadata = opencodeReadyWaitPatch(metadata, 'not_ready', `p${i}`, t) ?? metadata;
    }
    const now = t0.getTime() + 12 * 60_000 + 1_000;
    // Reason clock is only 1 s old, yet 12 min have passed since first seen.
    expect(staleOpencodeReadyReason(metadata, 'not_ready', now, 90_000, 10 * 60_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });
});
