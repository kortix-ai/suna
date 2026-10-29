import { afterEach, expect, jest, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const config = { KORTIX_WORKERS_ENABLED: false };
const queries: Array<{ sql: string; params: unknown[] }> = [];
let deletions = 0;
mock.module('../../config', () => ({ config }));
mock.module('../../shared/db', () => ({ db: {
  execute: async (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query)); return []; },
  delete: () => ({ where: async () => { deletions++; } }),
} }));
mock.module('../../shared/audit-scope', () => ({ runWorkerTick: async (_name: string, tick: () => Promise<void>) => tick() }));
mock.module('../../shared/crypto', () => ({ fingerprintTunnelCredentialHash: () => '' }));
mock.module('../../shared/instance', () => ({ API_INSTANCE: {}, API_INSTANCE_ID: 'current-api-instance', API_STARTED_AT: '2026-10-29T12:00:00Z' }));
mock.module('../../shared/pg-broadcast', () => ({ TUNNEL_FORWARD_CHANNEL: 'test-channel', isPgBroadcastListening: () => true, onTunnelForwardNotify() {} }));
mock.module('./relay', () => ({ tunnelRelay: {} }));
const { startTunnelRpcForwarder, stopTunnelRpcForwarder } = await import('./cluster-forwarder');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

afterEach(() => {
  stopTunnelRpcForwarder();
  config.KORTIX_WORKERS_ENABLED = false;
  queries.length = 0;
  deletions = 0;
  jest.useRealTimers();
});

test('API-only RPC transport claims only this live replica and never sweeps inherited expired rows', async () => {
  jest.useFakeTimers();
  startTunnelRpcForwarder();
  jest.advanceTimersByTime(1);
  await flush();
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('target_relay_owner_id = $1');
  expect(queries[0]!.params[0]).toBe('current-api-instance');
  expect(deletions).toBe(0);
});

test('worker-enabled RPC transport also removes expired rows', async () => {
  jest.useFakeTimers();
  config.KORTIX_WORKERS_ENABLED = true;
  startTunnelRpcForwarder();
  jest.advanceTimersByTime(1);
  await flush();
  expect(queries).toHaveLength(1);
  expect(deletions).toBe(1);
});
