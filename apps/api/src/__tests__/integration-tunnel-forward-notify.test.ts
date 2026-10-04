/**
 * Integration test (real local PostgreSQL): a NOTIFY wakes the tunnel RPC
 * forwarder and the waiting requester, and neither depends on it.
 *
 * `LISTEN`/`NOTIFY` is a database feature, so a fake bus proves nothing here.
 * This process is one API replica. A second `postgres` client stands in for
 * the other replica: it writes rows the way that replica's code does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { tunnelConnections } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import postgres from 'postgres';

import { config } from '../lib/config';
import { hashSecretKey } from '../shared/crypto';
import { db } from '../shared/db';
import { API_INSTANCE_ID } from '../shared/instance';
import {
  TUNNEL_FORWARD_CHANNEL,
  startConfigBaseMoveBroadcast,
  stopConfigBaseMoveBroadcast,
} from '../shared/pg-broadcast';
import {
  relayRpcToConnectedAgent,
  startTunnelRpcForwarder,
  stopTunnelRpcForwarder,
} from '../tunnel/core/cluster-forwarder';

const PEER_ID = 'peer-replica:1';
const tunnels = new Set<string>();
const notifications: string[] = [];
let peer: postgres.Sql;

beforeAll(async () => {
  peer = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await peer.listen(TUNNEL_FORWARD_CHANNEL, (payload) => notifications.push(payload));
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
});

afterEach(async () => {
  stopTunnelRpcForwarder();
  // Forward rows cascade with their tunnel.
  if (tunnels.size > 0) {
    await db.delete(tunnelConnections).where(inArray(tunnelConnections.tunnelId, [...tunnels]));
  }
  tunnels.clear();
  notifications.length = 0;
});

afterAll(async () => {
  await stopConfigBaseMoveBroadcast();
  await peer.end({ timeout: 2 }).catch(() => {});
});

async function createTunnel(relayOwnerId: string) {
  const tunnelId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  await db.insert(tunnelConnections).values({
    tunnelId,
    accountId,
    name: `forward-notify-${tunnelId}`,
    capabilities: ['filesystem'],
    setupTokenHash: hashSecretKey(`kortix_tnl_${crypto.randomUUID()}`),
    status: 'online',
    relayOwnerId,
    relayOwnerHeartbeatAt: new Date(),
  });
  tunnels.add(tunnelId);
  return { tunnelId, accountId };
}

/** The peer replica queues a forward for this replica, with or without its NOTIFY. */
async function peerQueuesForward(tunnel: { tunnelId: string; accountId: string }, notify: boolean) {
  const [row] = await peer<{ request_id: string }[]>`
    insert into kortix.tunnel_rpc_forwards
      (tunnel_id, account_id, requester_relay_owner_id, target_relay_owner_id, method, expires_at)
    values
      (${tunnel.tunnelId}, ${tunnel.accountId}, ${PEER_ID}, ${API_INSTANCE_ID}, 'fs.read',
       now() + interval '30 seconds')
    returning request_id
      ${notify ? peer`, pg_notify(${TUNNEL_FORWARD_CHANNEL}, target_relay_owner_id)` : peer``}
  `;
  return row!.request_id;
}

async function forwardStatus(requestId: string, status: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await peer<{ status: string; error: { message?: string } | null }[]>`
      select status, error from kortix.tunnel_rpc_forwards where request_id = ${requestId}
    `;
    if (row?.status === status) return row;
    await Bun.sleep(20);
  }
  throw new Error(`Forward ${requestId} did not reach ${status} within ${timeoutMs}ms`);
}

async function until(condition: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

describe('tunnel RPC forwards over LISTEN/NOTIFY', () => {
  test('an idle forwarder does not poll every 100 ms, and a NOTIFY wakes it before its 1 s fallback', async () => {
    const tunnel = await createTunnel(API_INSTANCE_ID);
    const claims = spyOn(db, 'execute');
    try {
      startTunnelRpcForwarder();
      await Bun.sleep(500);
      // One claim at start; the next is the 1 s fallback. The 100 ms poll made 5.
      expect(claims.mock.calls.length).toBeLessThanOrEqual(2);

      const requestId = await peerQueuesForward(tunnel, true);
      // No agent socket in this process, so the forwarder answers NOT_CONNECTED.
      // 500 ms idle + 400 ms here ends before the 1 s fallback poll can fire.
      const row = await forwardStatus(requestId, 'error', 400);
      expect(row.error?.message).toContain('not connected');
      // The result write carries its own NOTIFY: the request id, for the requester.
      await until(() => notifications.includes(requestId), 1_000, 'no result NOTIFY');
    } finally {
      claims.mockRestore();
    }
  }, 20_000);

  test('a forward queued with no NOTIFY is still claimed, by the fallback poll', async () => {
    const tunnel = await createTunnel(API_INSTANCE_ID);
    startTunnelRpcForwarder();
    await Bun.sleep(300);
    // A replica on the previous version, or a lost NOTIFY.
    const requestId = await peerQueuesForward(tunnel, false);
    const row = await forwardStatus(requestId, 'error', 4_000);
    expect(row.error?.message).toContain('not connected');
  }, 20_000);

  test('a requester queues its forward with a NOTIFY for the owner and returns on the result NOTIFY', async () => {
    const tunnel = await createTunnel(PEER_ID);
    const startedAt = Date.now();
    const pending = relayRpcToConnectedAgent({
      ...tunnel,
      method: 'fs.read',
      params: { path: '/tmp/synthetic' },
    });
    // The insert notified the owner replica by its instance id.
    await until(() => notifications.includes(PEER_ID), 2_000, 'no forward NOTIFY for the owner');
    // The owner writes the result and its NOTIFY in one statement.
    await peer`
      update kortix.tunnel_rpc_forwards
      set status = 'completed', result = ${peer.json({ ok: true })}, completed_at = now()
      where tunnel_id = ${tunnel.tunnelId}
      returning pg_notify(${TUNNEL_FORWARD_CHANNEL}, request_id::text)
    `;
    expect(await pending).toEqual({ ok: true });
    // The requester's fallback poll is 1 s. Only the NOTIFY returns this early.
    expect(Date.now() - startedAt).toBeLessThan(700);
  }, 20_000);
});
