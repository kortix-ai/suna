import { describe, expect, test } from 'bun:test';
import { fileServerHealthState } from './server-health-state';

describe('fileServerHealthState', () => {
  test('keeps Files available while daemon is connected but runtime readiness is false', () => {
    expect(fileServerHealthState('connected', false, '1.2.3')).toEqual({
      healthy: true,
      version: '1.2.3',
    });
  });
  test('reports a truly unreachable daemon as unhealthy', () => {
    expect(fileServerHealthState('unreachable', false, null)).toEqual({
      healthy: false,
      version: '',
    });
  });
  test('keeps initial unresolved state loading', () => {
    expect(fileServerHealthState('connecting', null, null)).toBeUndefined();
  });

  /**
   * `status` tracks the socket; it is not cleared when the control plane parks
   * the box. `use-session` pins it to `connected` on switch with no poller, and
   * `use-runtime-reconnect`'s parked branch deliberately leaves it alone. So on
   * a parked session the store held `status: 'connected', healthy: false` and
   * this function answered "healthy" — which opened the Files gate over a box
   * that was not running, and started the refused-request loop.
   *
   * The `connected` + `runtimeHealthy: false` case above stays healthy on
   * purpose: the file daemon is reachable while OpenCode is merely not ready
   * yet. Parked is the case where nothing is reachable at all.
   */
  test('a parked box is not healthy — nothing is running to serve files', () => {
    expect(fileServerHealthState('connected', false, '1.2.3', true)).toEqual({
      healthy: false,
      version: '1.2.3',
    });
  });

  test('parked outranks a stale connected+healthy pair', () => {
    expect(fileServerHealthState('connected', true, '1.2.3', true)).toEqual({
      healthy: false,
      version: '1.2.3',
    });
  });

  test('omitting parked keeps the existing answer — additive, not a behaviour change', () => {
    expect(fileServerHealthState('connected', false, '1.2.3')).toEqual({
      healthy: true,
      version: '1.2.3',
    });
  });
});
