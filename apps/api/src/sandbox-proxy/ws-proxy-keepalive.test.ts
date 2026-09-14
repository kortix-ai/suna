import { describe, expect, test } from 'bun:test';

import {
  PREVIEW_WS_KEEPALIVE_MS,
  pingPreviewWsLegs,
  stopPreviewWsKeepalive,
  type PreviewWsData,
} from './ws-proxy';

// The incident this file pins: an idle terminal WebSocket was dropped on the
// API→sandbox leg after exactly 60 s with no bytes on it. Measured on a real
// Platinum box, three controlled arms on the same sandbox in the same minute:
//   - no keepalive          -> CLOSE +60484ms code=4500 "Connection ended"
//   - PING from the browser -> CLOSE +60455ms (never reaches the upstream leg)
//   - DATA from the browser -> alive past 80s (forwarded, so the leg stays busy)
// The browser can only render that drop as close code 1006, which is the
// "Reconnecting in Ns (code 1006)" ladder users hit once a minute, forever.
const MEASURED_UPSTREAM_CUT_MS = 60_000;

function fakeState(upstreamReadyState: number): PreviewWsData & { pings: string[] } {
  const pings: string[] = [];
  const upstream = {
    readyState: upstreamReadyState,
    ping: () => pings.push('upstream'),
  } as unknown as WebSocket;
  return { type: 'preview-ws', url: 'wss://box/pty', headers: {}, upstream, pings };
}

function fakeWs(state: PreviewWsData & { pings: string[] }, clientPing?: () => void) {
  return {
    data: state,
    send: () => {},
    close: () => {},
    ping: clientPing ?? (() => state.pings.push('client')),
  };
}

describe('preview WebSocket keepalive', () => {
  test('pings BOTH legs — the upstream leg is the one that gets cut', () => {
    const state = fakeState(WebSocket.OPEN);
    pingPreviewWsLegs(fakeWs(state) as never);
    expect(state.pings).toEqual(['client', 'upstream']);
  });

  test('a client leg that rejects the ping still leaves the upstream pinged', () => {
    const state = fakeState(WebSocket.OPEN);
    const ws = fakeWs(state, () => {
      throw new Error('socket closing');
    });
    expect(() => pingPreviewWsLegs(ws as never)).not.toThrow();
    expect(state.pings).toEqual(['upstream']);
  });

  test('never pings an upstream that is not open', () => {
    const state = fakeState(WebSocket.CONNECTING);
    pingPreviewWsLegs(fakeWs(state) as never);
    expect(state.pings).toEqual(['client']);
  });

  test('tolerates a connection whose upstream never came up', () => {
    const state = { type: 'preview-ws', url: 'wss://box/pty', headers: {}, pings: [] } as never;
    expect(() => pingPreviewWsLegs(fakeWs(state) as never)).not.toThrow();
  });

  test('stopping the keepalive clears the interval and is idempotent', () => {
    const state: PreviewWsData = { type: 'preview-ws', url: 'wss://box/pty', headers: {} };
    state.keepalive = setInterval(() => {}, 60_000);
    stopPreviewWsKeepalive(state);
    expect(state.keepalive).toBeUndefined();
    expect(() => stopPreviewWsKeepalive(state)).not.toThrow();
  });

  // A ping interval at or above the measured cut keeps nothing alive. Two pings
  // must fit inside the window so a single dropped one does not cost the socket.
  test('the interval clears the measured 60s upstream cut twice over', () => {
    expect(PREVIEW_WS_KEEPALIVE_MS * 2).toBeLessThan(MEASURED_UPSTREAM_CUT_MS);
  });
});
