import { describe, expect, test } from 'bun:test';
import { isRuntimeLivenessEvent, isStreamContentEvent } from './keepalive';

describe('isRuntimeLivenessEvent', () => {
  // The daemon injects this every 20s from a hop ABOVE opencode. It proves the
  // proxy is alive, not that the runtime is. Counting it as liveness defeated
  // both the 60s heartbeat watchdog and the SSE-gap rehydrate, so a wedged
  // opencode behind a healthy TCP stream never triggered a reconnect.
  test('a daemon keepalive is not runtime liveness', () => {
    expect(isRuntimeLivenessEvent({ type: 'kortix.keepalive' })).toBe(false);
  });

  test('a real runtime event is runtime liveness', () => {
    expect(isRuntimeLivenessEvent({ type: 'message.part.updated' })).toBe(true);
    expect(isRuntimeLivenessEvent({ type: 'session.status' })).toBe(true);
  });

  test('an untyped frame is not runtime liveness', () => {
    expect(isRuntimeLivenessEvent({})).toBe(false);
    expect(isRuntimeLivenessEvent(undefined)).toBe(false);
  });
});

describe('isStreamContentEvent', () => {
  // A reconnect decides whether frames were lost by asking when CONTENT last
  // arrived. Frames that only prove a connection is open say nothing about
  // whether the runtime's output is still reaching this subscriber.
  test('connection frames are not content', () => {
    expect(isStreamContentEvent({ type: 'kortix.keepalive' })).toBe(false);
    expect(isStreamContentEvent({ type: 'server.connected' })).toBe(false);
    expect(isStreamContentEvent({ type: 'server.heartbeat' })).toBe(false);
  });

  test('runtime output is content', () => {
    expect(isStreamContentEvent({ type: 'message.part.updated' })).toBe(true);
    expect(isStreamContentEvent({ type: 'message.part.delta' })).toBe(true);
    expect(isStreamContentEvent({ type: 'session.status' })).toBe(true);
  });

  test('an untyped frame is not content', () => {
    expect(isStreamContentEvent({})).toBe(false);
    expect(isStreamContentEvent(undefined)).toBe(false);
  });
});
