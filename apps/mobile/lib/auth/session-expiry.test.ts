import { describe, expect, test } from 'bun:test';
import {
  EXPIRY_CHECK_COOLDOWN_MS,
  classifyRefreshResult,
  createSessionExpiryMonitor,
  type RefreshResult,
  type SessionExpiryPhase,
} from './session-expiry';

describe('classifyRefreshResult', () => {
  test('a refreshed session is valid', () => {
    expect(classifyRefreshResult({ error: null, hasSession: true })).toBe('valid');
  });

  test('network failures are transient, never expired', () => {
    expect(classifyRefreshResult({ error: { name: 'AuthRetryableFetchError', status: 0 }, hasSession: false })).toBe('transient');
    expect(classifyRefreshResult({ error: { name: 'AuthRetryableFetchError', status: 400 }, hasSession: false })).toBe('transient');
    expect(classifyRefreshResult({ error: { name: 'TypeError' }, hasSession: false })).toBe('transient');
    expect(classifyRefreshResult({ error: { name: 'AuthUnknownError', status: 502 }, hasSession: false })).toBe('transient');
    expect(classifyRefreshResult({ error: { name: 'AuthApiError', status: 429 }, hasSession: false })).toBe('transient');
    expect(classifyRefreshResult({ error: { name: 'AuthApiError', status: 408 }, hasSession: false })).toBe('transient');
    expect(classifyRefreshResult({ error: null, hasSession: false })).toBe('transient');
  });

  test('a dead refresh token or a missing session is expired', () => {
    expect(classifyRefreshResult({ error: { name: 'AuthApiError', status: 400 }, hasSession: false })).toBe('expired');
    expect(classifyRefreshResult({ error: { name: 'AuthApiError', status: 401 }, hasSession: false })).toBe('expired');
    expect(classifyRefreshResult({ error: { name: 'AuthApiError', status: 403 }, hasSession: false })).toBe('expired');
    expect(classifyRefreshResult({ error: { name: 'AuthSessionMissingError', status: 400 }, hasSession: false })).toBe('expired');
  });
});

function setup(results: RefreshResult[]) {
  let clock = 0;
  const phases: SessionExpiryPhase[] = [];
  let refreshes = 0;
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const monitor = createSessionExpiryMonitor({
    now: () => clock,
    onChange: (phase) => phases.push(phase),
    refresh: async () => {
      refreshes++;
      if (gate) await gate;
      return results.shift() ?? { error: null, hasSession: true };
    },
  });
  return {
    monitor,
    phases,
    refreshes: () => refreshes,
    advance: (ms: number) => {
      clock += ms;
    },
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
    },
    release: () => release?.(),
  };
}

const EXPIRED: RefreshResult = { error: { name: 'AuthApiError', status: 400 }, hasSession: false };
const OFFLINE: RefreshResult = { error: { name: 'AuthRetryableFetchError', status: 0 }, hasSession: false };

describe('createSessionExpiryMonitor', () => {
  test('ignores 401s while signed out', async () => {
    const t = setup([EXPIRED]);
    expect(await t.monitor.reportUnauthorized()).toBeNull();
    expect(t.refreshes()).toBe(0);
    expect(t.monitor.phase()).toBe('signed-out');
  });

  test('a 401 whose refresh fails for good expires once', async () => {
    const t = setup([EXPIRED]);
    t.monitor.arm();
    expect(await t.monitor.reportUnauthorized()).toBe('expired');
    expect(t.monitor.phase()).toBe('expired');
    // Further 401s neither re-check nor re-fire.
    expect(await t.monitor.reportUnauthorized()).toBeNull();
    expect(t.refreshes()).toBe(1);
    expect(t.phases.filter((p) => p === 'expired')).toHaveLength(1);
  });

  test('a burst of 401s runs one refresh', async () => {
    const t = setup([EXPIRED]);
    t.monitor.arm();
    t.hold();
    const first = t.monitor.reportUnauthorized();
    const others = [t.monitor.reportUnauthorized(), t.monitor.reportUnauthorized()];
    t.release();
    expect(await first).toBe('expired');
    expect(await Promise.all(others)).toEqual([null, null]);
    expect(t.refreshes()).toBe(1);
  });

  test('a network failure never expires, and 401s are quiet for the cooldown', async () => {
    const t = setup([OFFLINE, EXPIRED]);
    t.monitor.arm();
    expect(await t.monitor.reportUnauthorized()).toBe('transient');
    expect(t.monitor.phase()).toBe('armed');
    t.advance(EXPIRY_CHECK_COOLDOWN_MS - 1);
    expect(await t.monitor.reportUnauthorized()).toBeNull();
    t.advance(1);
    expect(await t.monitor.reportUnauthorized()).toBe('expired');
  });

  test('a refresh that throws is transient', async () => {
    const monitor = createSessionExpiryMonitor({
      onChange: () => {},
      refresh: () => Promise.reject(new Error('offline')),
    });
    monitor.arm();
    expect(await monitor.reportUnauthorized()).toBe('transient');
    expect(monitor.phase()).toBe('armed');
  });

  test('a valid refresh keeps the user signed in', async () => {
    const t = setup([{ error: null, hasSession: true }]);
    t.monitor.arm();
    expect(await t.monitor.reportUnauthorized()).toBe('valid');
    expect(t.monitor.phase()).toBe('armed');
  });

  test('an unrequested SIGNED_OUT expires; a deliberate one does not', () => {
    const t = setup([]);
    t.monitor.arm();
    t.monitor.signedOut();
    expect(t.monitor.phase()).toBe('expired');

    const u = setup([]);
    u.monitor.arm();
    u.monitor.disarm();
    u.monitor.signedOut();
    expect(u.monitor.phase()).toBe('signed-out');
  });

  test('a sign-out during a check wins over its verdict', async () => {
    const t = setup([EXPIRED]);
    t.monitor.arm();
    t.hold();
    const check = t.monitor.reportUnauthorized();
    t.monitor.disarm();
    t.release();
    await check;
    expect(t.monitor.phase()).toBe('signed-out');
  });

  test('signing in again clears an expiry', () => {
    const t = setup([]);
    t.monitor.arm();
    t.monitor.signedOut();
    t.monitor.arm();
    expect(t.monitor.phase()).toBe('armed');
  });
});
