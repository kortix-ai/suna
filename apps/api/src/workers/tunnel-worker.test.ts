import { afterEach, expect, jest, mock, test } from 'bun:test';

const config = { TUNNEL_ENABLED: true, KORTIX_WORKERS_ENABLED: false };
const calls: string[] = [];
mock.module('../config', () => ({ config }));
mock.module('../shared/audit-scope', () => ({ runWorkerTick: async (_name: string, tick: () => void) => tick() }));
mock.module('../tunnel/core/cluster-forwarder', () => ({
  startTunnelRpcForwarder: () => calls.push('rpc'), stopTunnelRpcForwarder() {},
}));
mock.module('../tunnel/core/heartbeat', () => ({ heartbeatManager: { start: () => calls.push('heartbeat'), stop() {} } }));
mock.module('../tunnel/core/relay', () => ({ tunnelRelay: { shutdown() {} } }));
mock.module('../tunnel/registrations', () => ({ runTunnelCleanupOnce: () => calls.push('cleanup') }));
mock.module('../tunnel/relay-persistence', () => ({ registerTunnelRelayPersistence: () => calls.push('persistence') }));
const { startTunnelService, stopTunnelService } = await import('./tunnel-worker');

afterEach(() => {
  stopTunnelService();
  config.TUNNEL_ENABLED = true;
  config.KORTIX_WORKERS_ENABLED = false;
  calls.length = 0;
  jest.useRealTimers();
});

test('API-only tunnel keeps heartbeat, RPC transport, and relay registration without tenant cleanup', () => {
  jest.useFakeTimers();
  startTunnelService();
  jest.advanceTimersByTime(10 * 60_000);
  expect(calls).toEqual(['heartbeat', 'rpc', 'persistence']);
});

test('worker-enabled tunnel starts queue polling and recurring cleanup', () => {
  jest.useFakeTimers();
  config.KORTIX_WORKERS_ENABLED = true;
  startTunnelService();
  expect(calls).toContain('rpc');
  jest.advanceTimersByTime(5 * 60_000);
  expect(calls).toContain('cleanup');
});

test('disabled tunnel starts neither request services nor background workers', () => {
  config.TUNNEL_ENABLED = false;
  startTunnelService();
  expect(calls).toEqual([]);
});
