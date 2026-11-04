import { afterEach, expect, jest, mock, test } from 'bun:test';

const config = { TUNNEL_ENABLED: true };
const calls: string[] = [];
mock.module('../config', () => ({ config }));
mock.module('../tunnel/core/cluster-forwarder', () => ({
  startTunnelRpcForwarder: () => calls.push('rpc'), stopTunnelRpcForwarder() {},
}));
mock.module('../tunnel/core/heartbeat', () => ({ heartbeatManager: { start: () => calls.push('heartbeat'), stop() {} } }));
mock.module('../tunnel/core/rate-limiter', () => ({ tunnelRateLimiter: { cleanup: () => calls.push('rate-limit-buckets') } }));
mock.module('../tunnel/core/relay', () => ({ tunnelRelay: { shutdown() {} } }));
mock.module('../tunnel/relay-persistence', () => ({ registerTunnelRelayPersistence: () => calls.push('persistence') }));
const { startTunnelService, stopTunnelService } = await import('./tunnel');

afterEach(() => {
  stopTunnelService();
  config.TUNNEL_ENABLED = true;
  calls.length = 0;
  jest.useRealTimers();
});

test('every process keeps heartbeat, RPC transport, relay registration and its own rate-limit buckets, and runs no database sweep', () => {
  jest.useFakeTimers();
  startTunnelService();
  expect(calls).toEqual(['heartbeat', 'rpc', 'persistence']);
  jest.advanceTimersByTime(10 * 60_000);
  expect(calls).toEqual(['heartbeat', 'rpc', 'persistence', 'rate-limit-buckets', 'rate-limit-buckets']);
});

test('disabled tunnel starts nothing', () => {
  config.TUNNEL_ENABLED = false;
  startTunnelService();
  expect(calls).toEqual([]);
});
