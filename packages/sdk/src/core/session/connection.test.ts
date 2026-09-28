import { describe, expect, test } from 'bun:test';
import {
  connectionFromHealth,
  connectionIsFaulted,
  CONNECTION_FAULT_GRACE_MS,
  INITIAL_SETTLED_CONNECTION,
  projectSessionConnection,
  settleSessionConnection,
  type SessionConnectionInputs,
  type SettledConnection,
} from './connection';
import type { SessionHealthResult } from './health';

const base: SessionConnectionInputs = { sandbox: null, runtimeReady: false };

describe('projectSessionConnection', () => {
  // The reported failure: a reload of a session whose sandbox is UP and
  // mid-turn announced "Waking this session up…" for seconds. The frontend had
  // asked nobody yet and turned that silence into a claim.
  test('a cold load knows NOTHING and says so', () => {
    expect(projectSessionConnection(base)).toBe('unknown');
  });

  test('a running sandbox that has not answered yet is CONNECTING, never waking', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'running' })).toBe('connecting');
  });

  test('only the control plane saying the box is down earns the word "waking"', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'stopped' })).toBe('waking');
    expect(projectSessionConnection({ ...base, sandbox: 'provisioning' })).toBe('waking');
    expect(projectSessionConnection({ ...base, sandbox: 'archived' })).toBe('waking');
  });

  test('a health pass is live', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'stopped', runtimeReady: true })).toBe(
      'live',
    );
  });

  // Content is the runtime itself, not a report about it: it outranks a probe
  // that has given up on a different path, and a row that is out of date.
  test('content arriving is live, over any probe and any row', () => {
    expect(
      projectSessionConnection({
        ...base,
        sandbox: 'stopped',
        unreachable: true,
        stalled: true,
        activityFresh: true,
      }),
    ).toBe('live');
  });

  test('a probe that gave up, or a boot that stalled, is unreachable', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'running', unreachable: true })).toBe(
      'unreachable',
    );
    expect(projectSessionConnection({ ...base, sandbox: 'running', stalled: true })).toBe(
      'unreachable',
    );
  });

  test('pre-boot lifecycle states are waking', () => {
    for (const sandbox of ['queued', 'branching'] as const) {
      expect(projectSessionConnection({ ...base, sandbox })).toBe('waking');
    }
  });

  test('a completed session has nothing to wake and nothing to announce', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'completed' })).toBe('unknown');
  });

  test('a failed sandbox is a fault, not a wait', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'failed' })).toBe('unreachable');
  });

  /**
   * `project_sessions.status` is read on a 30s freshness tier, so it CAN be up
   * to half a minute behind the box. Both directions of that lag are covered by
   * ordering alone — which is the reason the probe outranks the row.
   */
  test('a stale `stopped` row never contradicts a live runtime', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'stopped', runtimeReady: true })).toBe(
      'live',
    );
    expect(projectSessionConnection({ ...base, sandbox: 'stopped', activityFresh: true })).toBe(
      'live',
    );
  });

  test('a stale `running` row never hides a dead runtime', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'running', unreachable: true })).toBe(
      'unreachable',
    );
  });
});

describe('connectionIsFaulted', () => {
  test('only unreachable is a fault — a wait is not', () => {
    expect(connectionIsFaulted('unreachable')).toBe(true);
    for (const state of ['unknown', 'connecting', 'waking', 'live'] as const) {
      expect(connectionIsFaulted(state)).toBe(false);
    }
  });
});

/**
 * One health probe, read in the connection vocabulary. Mobile's thread counted
 * anything but a 200 as "Unreachable", so a computer that was parked (the
 * control plane answers for it) or still booting read as a fault.
 */
describe('connectionFromHealth', () => {
  const result = (overrides: Partial<SessionHealthResult>): SessionHealthResult => ({
    status: 200,
    ok: true,
    health: { status: 'ok', runtimeReady: true },
    body: '',
    hop: null,
    upstreamStatus: null,
    ...overrides,
  });

  test('a ready runtime is live', () => {
    expect(connectionFromHealth(result({}))).toBe('live');
  });

  test('the control plane answering for a box that is not up is waking, not a fault', () => {
    expect(
      connectionFromHealth(
        result({ status: 503, ok: false, hop: 'control_plane', health: { status: 'starting' } }),
      ),
    ).toBe('waking');
  });

  test('a runtime that answers but is still booting is connecting', () => {
    expect(
      connectionFromHealth(result({ status: 503, ok: false, health: { status: 'starting' } })),
    ).toBe('connecting');
    expect(
      connectionFromHealth(result({ health: { status: 'starting', runtimeReady: false } })),
    ).toBe('connecting');
  });

  test('a hop that dials the box and fails is unreachable', () => {
    expect(connectionFromHealth(result({ status: 502, ok: false, hop: 'provider_ingress', health: null }))).toBe(
      'unreachable',
    );
    expect(connectionFromHealth(result({ status: 502, ok: false, hop: 'daemon', health: null }))).toBe(
      'unreachable',
    );
    expect(connectionFromHealth(result({ status: 504, ok: false, health: null }))).toBe('unreachable');
  });

  test('no probe, or no runtime to probe, says nothing', () => {
    expect(connectionFromHealth(null)).toBe('unknown');
    expect(connectionFromHealth(result({ status: 0, ok: false, health: null }))).toBe('unknown');
  });
});

describe('settleSessionConnection — one probe never flips the answer', () => {
  const t0 = 1_000_000;
  const live: SettledConnection = { connection: 'live', faultSinceMs: null };

  // The report: status flapped unconnected -> unreachable -> reachable. Each
  // word followed ONE probe. A single miss on a live computer is noise.
  test('a live computer stays live through one failed probe', () => {
    expect(settleSessionConnection(live, 'unreachable', t0)).toEqual({ connection: 'live', faultSinceMs: t0 });
  });

  test('a live computer stays live through one not-ready answer', () => {
    expect(settleSessionConnection(live, 'connecting', t0).connection).toBe('live');
  });

  test('failures that persist past the grace period read unreachable', () => {
    const first = settleSessionConnection(live, 'unreachable', t0);
    const later = settleSessionConnection(first, 'unreachable', t0 + CONNECTION_FAULT_GRACE_MS);
    expect(later).toEqual({ connection: 'unreachable', faultSinceMs: t0 });
  });

  test('a not-ready answer that persists reads connecting, never unreachable', () => {
    const first = settleSessionConnection(live, 'connecting', t0);
    expect(settleSessionConnection(first, 'connecting', t0 + CONNECTION_FAULT_GRACE_MS).connection).toBe('connecting');
  });

  test('a first failed probe on a cold load reads connecting, not unreachable', () => {
    expect(settleSessionConnection(INITIAL_SETTLED_CONNECTION, 'unreachable', t0)).toEqual({
      connection: 'connecting',
      faultSinceMs: t0,
    });
  });

  test('one success clears the fault at once', () => {
    const down = { connection: 'unreachable', faultSinceMs: t0 } satisfies SettledConnection;
    expect(settleSessionConnection(down, 'live', t0 + 1)).toEqual(live);
  });

  test('a success inside the grace period resets the clock', () => {
    const miss = settleSessionConnection(live, 'unreachable', t0);
    const back = settleSessionConnection(miss, 'live', t0 + 1_000);
    const missAgain = settleSessionConnection(back, 'unreachable', t0 + CONNECTION_FAULT_GRACE_MS);
    expect(missAgain.connection).toBe('live');
  });

  test('the control plane saying the box is parked is positive evidence, applied at once', () => {
    expect(settleSessionConnection(live, 'waking', t0)).toEqual({ connection: 'waking', faultSinceMs: null });
  });

  test('an observation of nothing changes nothing', () => {
    expect(settleSessionConnection(live, 'unknown', t0)).toBe(live);
  });
});
