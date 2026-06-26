import { describe, expect, test } from 'bun:test';
import { isTunnelConnectionLive, tunnelLiveWindowMs } from '../tunnel/core/cluster-forwarder';

describe('tunnel cluster liveness', () => {
  test('fresh relay-owner heartbeat is live across API replicas', () => {
    expect(
      isTunnelConnectionLive({
        status: 'online',
        relayOwnerId: 'api-a:123',
        relayOwnerHeartbeatAt: new Date(),
        lastHeartbeatAt: null,
      }),
    ).toBe(true);
  });

  test('status alone is not enough without a relay owner', () => {
    expect(
      isTunnelConnectionLive({
        status: 'online',
        relayOwnerId: null,
        relayOwnerHeartbeatAt: new Date(),
        lastHeartbeatAt: new Date(),
      }),
    ).toBe(false);
  });

  test('stale relay-owner heartbeat is offline', () => {
    expect(
      isTunnelConnectionLive({
        status: 'online',
        relayOwnerId: 'api-a:123',
        relayOwnerHeartbeatAt: new Date(Date.now() - tunnelLiveWindowMs() - 1_000),
        lastHeartbeatAt: new Date(),
      }),
    ).toBe(false);
  });

  test('falls back to the legacy heartbeat for rows written during rollout', () => {
    expect(
      isTunnelConnectionLive({
        status: 'online',
        relayOwnerId: 'api-a:123',
        relayOwnerHeartbeatAt: null,
        lastHeartbeatAt: new Date(),
      }),
    ).toBe(true);
  });
});
