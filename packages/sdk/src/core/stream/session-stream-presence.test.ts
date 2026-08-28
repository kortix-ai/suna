import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getSessionAuditTick,
  isSessionRuntimeChannelLive,
  isSessionStreamConnected,
  isSessionTurnCorroborated,
  markSessionAuditWatermark,
  markSessionControlTurn,
  markSessionRuntimeChannelLive,
  markSessionStreamConnected,
  resetSessionStreamPresence,
  subscribeSessionAudit,
  subscribeSessionStreamPresence,
} from './session-stream-presence';

beforeEach(() => resetSessionStreamPresence());

describe('session-stream presence', () => {
  test('a scope is connected while at least one connection reports connected', () => {
    expect(isSessionStreamConnected('p/s')).toBe(false);
    markSessionStreamConnected('p/s', true);
    expect(isSessionStreamConnected('p/s')).toBe(true);
    // A second connection (StrictMode double mount) stacks.
    markSessionStreamConnected('p/s', true);
    markSessionStreamConnected('p/s', false);
    expect(isSessionStreamConnected('p/s')).toBe(true);
    markSessionStreamConnected('p/s', false);
    expect(isSessionStreamConnected('p/s')).toBe(false);
  });

  test('scopes are independent', () => {
    markSessionStreamConnected('a/1', true);
    expect(isSessionStreamConnected('a/1')).toBe(true);
    expect(isSessionStreamConnected('b/2')).toBe(false);
  });

  test('subscribers are notified only when the boolean answer flips', () => {
    let notifications = 0;
    const unsubscribe = subscribeSessionStreamPresence('p/s', () => notifications++);
    markSessionStreamConnected('p/s', true);
    expect(notifications).toBe(1);
    markSessionStreamConnected('p/s', true); // 1 → 2 connections: answer unchanged
    expect(notifications).toBe(1);
    markSessionStreamConnected('p/s', false);
    expect(notifications).toBe(1);
    markSessionStreamConnected('p/s', false);
    expect(notifications).toBe(2);
    unsubscribe();
    markSessionStreamConnected('p/s', true);
    expect(notifications).toBe(2);
  });

  test('disconnect below zero never wedges the count', () => {
    markSessionStreamConnected('p/s', false);
    markSessionStreamConnected('p/s', true);
    expect(isSessionStreamConnected('p/s')).toBe(true);
  });
});

describe('runtime-channel liveness flag', () => {
  test('a scope reports the runtime channel live only after it is marked so', () => {
    expect(isSessionRuntimeChannelLive('p/s')).toBe(false);
    markSessionRuntimeChannelLive('p/s', true);
    expect(isSessionRuntimeChannelLive('p/s')).toBe(true);
    markSessionRuntimeChannelLive('p/s', false);
    expect(isSessionRuntimeChannelLive('p/s')).toBe(false);
  });

  test('the flag notifies the same subscription as presence, only on flips', () => {
    let notifications = 0;
    const unsubscribe = subscribeSessionStreamPresence('p/s', () => notifications++);
    markSessionRuntimeChannelLive('p/s', true);
    expect(notifications).toBe(1);
    markSessionRuntimeChannelLive('p/s', true);
    expect(notifications).toBe(1);
    markSessionRuntimeChannelLive('p/s', false);
    expect(notifications).toBe(2);
    unsubscribe();
  });
});

describe('audit watermark signal', () => {
  test('the tick advances ONLY when the fingerprint changes', () => {
    // A subscriber (the audit hook) keeps the scope alive — in production the
    // connected stream also holds it (`connected > 0`). Without either, `forget`
    // GCs the scope right after the mark, which is correct: nobody is watching.
    const un = subscribeSessionAudit('p/s', () => {});
    expect(getSessionAuditTick('p/s')).toBe(0);
    markSessionAuditWatermark('p/s', 'fp-1');
    expect(getSessionAuditTick('p/s')).toBe(1);
    // Same fingerprint (a reconnect replay) must NOT bump the tick — that would
    // re-read the audit rows for nothing.
    markSessionAuditWatermark('p/s', 'fp-1');
    expect(getSessionAuditTick('p/s')).toBe(1);
    markSessionAuditWatermark('p/s', 'fp-2');
    expect(getSessionAuditTick('p/s')).toBe(2);
    un();
  });

  test('with nobody watching, a mark is GC-clean (no leaked scope)', () => {
    markSessionAuditWatermark('gc/scope', 'fp-1');
    // No subscriber and no connection: the scope is forgotten, so the tick
    // reads 0 again. The next watermark after a subscriber mounts re-seeds it.
    expect(getSessionAuditTick('gc/scope')).toBe(0);
  });

  test('audit subscribers are notified on change, and separately from presence', () => {
    let audit = 0;
    let presence = 0;
    const un1 = subscribeSessionAudit('p/s', () => audit++);
    const un2 = subscribeSessionStreamPresence('p/s', () => presence++);
    markSessionAuditWatermark('p/s', 'fp-1');
    expect(audit).toBe(1);
    // A watermark change does NOT wake presence consumers (poll owners).
    expect(presence).toBe(0);
    // A connection flip does NOT wake audit consumers.
    markSessionStreamConnected('p/s', true);
    expect(audit).toBe(1);
    expect(presence).toBe(1);
    un1();
    un2();
  });
});

/**
 * `connected` is a PROMISE that the control channel will carry turn state.
 * Corroboration is that promise kept.
 *
 * Turn frames are pushed on CHANGE, so a session resumed with a row already
 * open produces neither a change nor a frame — while the `/turn` poll had
 * already stood down on `connected` alone. The stale row then read as
 * `working` for the full observation window, which is the "Gathering
 * thoughts..." over a finished transcript seen on every resume.
 */
describe('turn corroboration', () => {
  beforeEach(() => resetSessionStreamPresence());

  test('a fresh scope has not been answered', () => {
    expect(isSessionTurnCorroborated('p/s')).toBe(false);
    markSessionStreamConnected('p/s', true);
    expect(isSessionStreamConnected('p/s')).toBe(true);
    expect(isSessionTurnCorroborated('p/s')).toBe(false);
  });

  test('a control turn frame corroborates the scope', () => {
    markSessionStreamConnected('p/s', true);
    markSessionControlTurn('p/s');
    expect(isSessionTurnCorroborated('p/s')).toBe(true);
  });

  test('a RECONNECT starts uncorroborated again', () => {
    markSessionStreamConnected('p/s', true);
    markSessionControlTurn('p/s');
    expect(isSessionTurnCorroborated('p/s')).toBe(true);

    // The whole point: what the previous connection was told says nothing
    // about this one, and a reconnect is exactly when a stale open row is most
    // likely to be sitting in the cache.
    markSessionStreamConnected('p/s', false);
    markSessionStreamConnected('p/s', true);
    expect(isSessionTurnCorroborated('p/s')).toBe(false);
  });

  test('a refcount overlap is not a reconnect', () => {
    // StrictMode double-mounts and reconnect overlap hold two connections for
    // one scope. Neither crosses the boolean, so neither may discard an answer
    // the surviving connection already gave.
    markSessionStreamConnected('p/s', true);
    markSessionControlTurn('p/s');
    markSessionStreamConnected('p/s', true);
    markSessionStreamConnected('p/s', false);
    expect(isSessionStreamConnected('p/s')).toBe(true);
    expect(isSessionTurnCorroborated('p/s')).toBe(true);
  });

  test('presence subscribers are notified when the answer lands', () => {
    markSessionStreamConnected('p/s', true);
    let calls = 0;
    const off = subscribeSessionStreamPresence('p/s', () => calls++);
    markSessionControlTurn('p/s');
    expect(calls).toBe(1);
    markSessionControlTurn('p/s'); // already true — no churn
    expect(calls).toBe(1);
    off();
  });

  test('scopes do not share an answer', () => {
    markSessionStreamConnected('a/1', true);
    markSessionStreamConnected('b/2', true);
    markSessionControlTurn('a/1');
    expect(isSessionTurnCorroborated('a/1')).toBe(true);
    expect(isSessionTurnCorroborated('b/2')).toBe(false);
  });
});
