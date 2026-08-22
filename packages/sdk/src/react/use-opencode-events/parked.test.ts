import { beforeEach, describe, expect, test } from 'bun:test';
import { useSandboxConnectionStore } from '../../browser/stores/sandbox-connection-store';
import { handleEventStreamParked } from './parked';

// A parked stream is one that gave up after N consecutive hard failures on
// `/event` (see `openEventStream`'s `maxConsecutiveHardFailures`). Nothing
// re-opened it: `use-opencode-events` opens the stream from an effect keyed on
// `runtimeHealthy`, and the health probe addresses the DAEMON port — OpenCode
// can crash and restart (the "opencode is borderline crashing" session) while
// every probe keeps passing, so `healthy` never flips and the stream stays
// dead until a hard refresh. The desktop app never parks; it retries forever.
// Ours parks on purpose (dead sandboxes), so the park must hand control to the
// probe loop: mark the runtime unhealthy, the probe re-checks at its failing
// cadence, and the first healthy probe re-runs the effect → fresh stream.
describe('handleEventStreamParked', () => {
  beforeEach(() => {
    useSandboxConnectionStore.setState({
      status: 'connected',
      healthy: true,
      runtimeError: null,
      bootingSinceAt: null,
    });
  });

  test('marks the runtime unhealthy with a reason that names the park', () => {
    handleEventStreamParked({ consecutiveFailures: 3, lastError: new Error('HTTP 502') });
    const s = useSandboxConnectionStore.getState();
    expect(s.healthy).toBe(false);
    expect(s.runtimeError).toContain('event stream parked');
    expect(s.runtimeError).toContain('3');
    expect(s.runtimeError).toContain('HTTP 502');
    // The stall clock starts: a park that never recovers still trips the
    // existing unreachable bound instead of hanging in "reconnecting" forever.
    expect(s.bootingSinceAt).not.toBeNull();
  });

  test('a park with no final error still produces a readable reason', () => {
    handleEventStreamParked({ consecutiveFailures: 5, lastError: null });
    const s = useSandboxConnectionStore.getState();
    expect(s.healthy).toBe(false);
    expect(s.runtimeError).toContain('event stream parked');
    expect(s.runtimeError).toContain('5');
  });

  test('does not touch sandbox `status` — the sandbox may be fine, only the stream is dead', () => {
    handleEventStreamParked({ consecutiveFailures: 3, lastError: 'boom' });
    expect(useSandboxConnectionStore.getState().status).toBe('connected');
  });
});
