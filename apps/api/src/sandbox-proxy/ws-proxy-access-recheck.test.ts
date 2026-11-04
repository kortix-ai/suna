import { afterEach, expect, jest, test } from 'bun:test';

import { STREAM_ACCESS_RECHECK_MS } from '../shared/stream-access-recheck';
import { armPreviewWsAccessRecheck, recheckOpenPreviewWs, stopPreviewWsAccessRecheck, type PreviewWsData } from './ws-proxy';

afterEach(() => jest.useRealTimers());

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function fakePair(check: () => Promise<boolean>) {
  const closes: Array<[number | undefined, string | undefined]> = [];
  let upstreamClosed = false;
  const state: PreviewWsData = {
    type: 'preview-ws',
    url: 'wss://box/pty',
    headers: {},
    accessCheck: check,
    upstream: { close: () => { upstreamClosed = true; } } as unknown as WebSocket,
  };
  const ws = { data: state, send: () => {}, close: (code?: number, reason?: string) => closes.push([code, reason]) };
  return { ws, state, closes, upstreamClosed: () => upstreamClosed };
}

test('N2: a terminal WebSocket of a removed member closes with 4403 on the next 60 s re-check', async () => {
  jest.useFakeTimers();
  let allowed = true;
  const pair = fakePair(async () => allowed);
  armPreviewWsAccessRecheck(pair.ws as never);
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS);
  await flush();
  expect(pair.closes).toEqual([]);
  allowed = false; // removed from the private channel
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS);
  await flush();
  expect(pair.closes).toEqual([[4403, 'access revoked']]);
  expect(pair.upstreamClosed()).toBe(true);
  stopPreviewWsAccessRecheck(pair.state);
});

test('N2: a membership change on this replica re-checks open sockets at once', async () => {
  let allowed = true;
  const pair = fakePair(async () => allowed);
  armPreviewWsAccessRecheck(pair.ws as never);
  allowed = false;
  await recheckOpenPreviewWs();
  await flush();
  expect(pair.closes).toEqual([[4403, 'access revoked']]);
  stopPreviewWsAccessRecheck(pair.state);
});

test('a closed socket is no longer re-checked', async () => {
  let checks = 0;
  const pair = fakePair(async () => {
    checks += 1;
    return true;
  });
  armPreviewWsAccessRecheck(pair.ws as never);
  stopPreviewWsAccessRecheck(pair.state);
  await recheckOpenPreviewWs();
  expect(checks).toBe(0);
});

// The fail-closed rule (a private channel's session closes on a failed read,
// any other stays) lives in `sessionStreamAccessCheck`, the check every
// socket is armed with (space-access-bus.test.ts). The socket itself treats a
// check that still throws like an SSE stream does: it stays open.
test('a membership-change re-check that throws keeps the socket, as an SSE stream does', async () => {
  const pair = fakePair(async () => {
    throw new Error('db unavailable');
  });
  armPreviewWsAccessRecheck(pair.ws as never);
  await recheckOpenPreviewWs();
  await flush();
  expect(pair.closes).toEqual([]);
  stopPreviewWsAccessRecheck(pair.state);
});

test('a periodic re-check that throws keeps the socket; a later definite no closes it', async () => {
  jest.useFakeTimers();
  let fail = true;
  const pair = fakePair(async () => {
    if (fail) throw new Error('db unavailable');
    return false;
  });
  armPreviewWsAccessRecheck(pair.ws as never);
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS);
  await flush();
  expect(pair.closes).toEqual([]);
  fail = false;
  jest.advanceTimersByTime(STREAM_ACCESS_RECHECK_MS);
  await flush();
  expect(pair.closes).toEqual([[4403, 'access revoked']]);
  stopPreviewWsAccessRecheck(pair.state);
});
