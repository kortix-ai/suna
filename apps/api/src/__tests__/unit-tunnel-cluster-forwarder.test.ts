import { describe, expect, test } from 'bun:test';
import {
  forwardPollMs,
  isTunnelConnectionLive,
  tunnelLiveWindowMs,
} from '../services/tunnel/core/cluster-forwarder';

// A NOTIFY wakes the forwarder and the waiting requester. The poll is only the
// fallback, and only while this process holds the LISTEN.
describe('tunnel forward poll interval', () => {
  test('with the LISTEN up, a loop polls at its fallback interval', () => {
    expect(forwardPollMs(2_000, true)).toBe(2_000);
    expect(forwardPollMs(1_000, true)).toBe(1_000);
  });

  test('without the LISTEN, a loop polls every 100 ms, the rate before NOTIFY existed', () => {
    expect(forwardPollMs(2_000, false)).toBe(100);
    // No subscription is open in a unit test: the default is the degraded rate.
    expect(forwardPollMs(2_000)).toBe(100);
  });
});

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
