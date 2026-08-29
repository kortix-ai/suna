import { describe, expect, test } from 'bun:test';
import { isRuntimeLivenessEvent } from './keepalive';

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
