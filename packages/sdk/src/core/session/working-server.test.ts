import { describe, expect, test } from 'bun:test';
import {
  SERVER_WORKING_SEND_GRACE_MS,
  projectServerWorking,
  serverWorkingExpiryAtMs,
} from './working-server';

const NOW = 1_000_000;
const working = (state: 'working' | 'idle', extra: Record<string, unknown> = {}) => ({
  state,
  since: '2026-10-06T10:00:00.000Z',
  turn_token: state === 'working' ? 'tt_1' : null,
  pending_delivery: false,
  ...extra,
});

describe('projectServerWorking', () => {
  test('with no local receipt the server verdict decides, attributed to the server', () => {
    expect(projectServerWorking({ working: working('working'), atMs: NOW - 10, optimistic: null, abort: null, nowMs: NOW })).toMatchObject({
      state: 'working',
      source: 'server',
      turnId: 'tt_1',
      serverOpenTurnToken: 'tt_1',
    });
    expect(projectServerWorking({ working: working('idle'), atMs: NOW - 10, optimistic: null, abort: null, nowMs: NOW })).toMatchObject({
      state: 'idle',
      source: 'server',
      serverOpenTurnToken: null,
    });
  });

  test('pending delivery is working, flagged, and holds no turn token', () => {
    const projection = projectServerWorking({
      working: working('working', { turn_token: null, pending_delivery: true }),
      atMs: NOW,
      optimistic: null,
      abort: null,
      nowMs: NOW,
    });
    expect(projection).toMatchObject({ state: 'working', pendingDelivery: true, serverOpenTurnToken: null });
  });

  test('a send not yet seen by the server shows working until the server answers', () => {
    const receipt = { messageId: 'm1', atMs: NOW - 100, acceptedAtMs: null };
    expect(
      projectServerWorking({ working: working('idle'), atMs: NOW, optimistic: receipt, abort: null, nowMs: NOW }),
    ).toMatchObject({ state: 'working', source: 'optimistic', turnId: 'm1' });
  });

  test('an idle frame inside the grace after acceptance does not cancel the send', () => {
    const receipt = { messageId: 'm1', atMs: NOW - 500, acceptedAtMs: NOW - 400 };
    expect(
      projectServerWorking({ working: working('idle'), atMs: NOW, optimistic: receipt, abort: null, nowMs: NOW }).state,
    ).toBe('working');
    // Past the grace, the server's idle is believed: the send ran and ended.
    expect(
      projectServerWorking({
        working: working('idle'),
        atMs: NOW - 400 + SERVER_WORKING_SEND_GRACE_MS + 1,
        optimistic: receipt,
        abort: null,
        nowMs: NOW + SERVER_WORKING_SEND_GRACE_MS,
      }),
    ).toMatchObject({ state: 'idle', source: 'server' });
  });

  test('a stop the server has not reflected yet shows idle; after the grace the server decides', () => {
    const abort = { atMs: NOW - 100, settledAtMs: NOW - 50 };
    expect(
      projectServerWorking({ working: working('working'), atMs: NOW, optimistic: null, abort, nowMs: NOW }),
    ).toMatchObject({ state: 'idle', source: 'optimistic' });
    expect(
      projectServerWorking({
        working: working('working'),
        atMs: NOW - 50 + SERVER_WORKING_SEND_GRACE_MS + 1,
        optimistic: null,
        abort,
        nowMs: NOW + SERVER_WORKING_SEND_GRACE_MS,
      }).state,
    ).toBe('working');
  });

  test('a receipt past its cap answers nothing', () => {
    const receipt = { messageId: 'm1', atMs: NOW - 120_000, acceptedAtMs: null };
    expect(
      projectServerWorking({ working: working('idle'), atMs: NOW, optimistic: receipt, abort: null, nowMs: NOW }).state,
    ).toBe('idle');
  });
});

describe('serverWorkingExpiryAtMs', () => {
  test('is null with no receipt, and the earliest receipt deadline otherwise', () => {
    expect(serverWorkingExpiryAtMs({ optimistic: null, abort: null })).toBeNull();
    const at = serverWorkingExpiryAtMs({
      optimistic: { messageId: 'm1', atMs: NOW, acceptedAtMs: NOW + 10 },
      abort: null,
    });
    expect(at).toBe(NOW + 10 + SERVER_WORKING_SEND_GRACE_MS);
  });
});
