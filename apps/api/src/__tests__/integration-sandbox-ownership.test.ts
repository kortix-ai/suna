import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDb, platformSettings, sessionSandboxes, type Database } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '../config';
import { sandboxDatabaseOwner, sandboxOwnershipMarker } from '../platform/sandbox-ownership';
import { PlatinumProvider } from '../platform/providers/platinum';
import { reapOrphanProviderBoxes } from '../projects/reaping/orphan-boxes';
import { hasProviderBoxReference } from '../projects/reaping/orphan-box-references';
import { db } from '../shared/db';

const peerName = `owner_peer_${crypto.randomUUID().replaceAll('-', '')}`;
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, { max: 1 });
let peer: Database;
const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const externalId = `sbx_test_${crypto.randomUUID()}`;
const original = {
  PLATINUM_API_URL: config.PLATINUM_API_URL,
  PLATINUM_API_KEY: config.PLATINUM_API_KEY,
  ALLOWED_SANDBOX_PROVIDERS: config.ALLOWED_SANDBOX_PROVIDERS,
  KORTIX_INSTANCE_ID: config.KORTIX_INSTANCE_ID,
};
const stops: string[] = [];
let fleet: Record<string, unknown>[] = [];
const server = Bun.serve({
  // Loopback by IP, not the default advertised `localhost`: Bun.serve binds
  // IPv4-only while bun's fetch resolves `localhost` to ::1 on hosts whose
  // resolver offers only IPv6 for it — every call below then dies with
  // "Unable to connect" and the reaper records a provider outage instead of
  // the listing this suite pins its assertions to.
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/sandboxes') {
      return Response.json({ rows: fleet, has_more: false });
    }
    const id = url.pathname.split('/')[3]!;
    if (request.method === 'POST' && url.pathname.endsWith('/stop')) stops.push(id);
    return Response.json({ id, state: 'stopped' });
  },
});
// `localhost` does not resolve on a platform sandbox, which answers
// ConnectionRefused instead of serving the stub fleet. Loopback by address
// connects on every host (the same convention as shared/platinum.test.ts).
const STUB_ORIGIN = `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Run through pnpm test -- --db-only sandbox-ownership');
  await admin.unsafe(`create database ${peerName}`);
  const url = new URL(process.env.TEST_DATABASE_ADMIN_URL!);
  url.pathname = `/${peerName}`;
  peer = createDb(url.toString(), { max: 2 });
  await peer.execute(sql`create schema kortix`);
  await peer.execute(sql`create table kortix.platform_settings (
    key varchar(255) primary key, value jsonb not null, updated_at timestamptz not null default now()
  )`);
  config.PLATINUM_API_URL = STUB_ORIGIN;
  config.PLATINUM_API_KEY = 'pt_synthetic_ownership';
  config.ALLOWED_SANDBOX_PROVIDERS = ['platinum'];
  config.KORTIX_INSTANCE_ID = undefined;
});

afterAll(async () => {
  Object.assign(config, original);
  server.stop(true);
  if (peer) await peer.$client.end();
  await admin.unsafe(`drop database if exists ${peerName} with (force)`);
  await admin.end();
});

test('replicas converge on one owner; separate databases never share it', async () => {
  const owners = await Promise.all(Array.from({ length: 12 }, () => sandboxDatabaseOwner(db)));
  expect(new Set(owners).size).toBe(1);
  expect(await sandboxDatabaseOwner(peer)).not.toBe(owners[0]);
  expect(await sandboxOwnershipMarker(peer)).not.toBe(await sandboxOwnershipMarker(db));
});

test('the same database separates scoped instances from an unset instance', async () => {
  const deployed = await sandboxOwnershipMarker();
  config.KORTIX_INSTANCE_ID = 'synthetic-worktree';
  expect(await sandboxOwnershipMarker()).not.toBe(deployed);
  config.KORTIX_INSTANCE_ID = undefined;
  expect(await sandboxOwnershipMarker()).toBe(deployed);
});

test('two databases sharing one environment and provider cannot orphan-stop each other', async () => {
  const own = await sandboxOwnershipMarker();
  const foreign = await sandboxOwnershipMarker(peer);
  const box = (id: string, marker: string) => ({
    id, state: 'running', created_at: '2026-01-01T00:00:00Z',
    metadata: { 'kortix.managed': marker, 'kortix.env': config.INTERNAL_KORTIX_ENV },
  });
  fleet = [box('sbx_synthetic_foreign', foreign), box('sbx_synthetic_legacy', 'true'), box('sbx_synthetic_orphan', own)];
  // This database has no row for either foreign box, reproducing the bad keep-set.
  expect(await hasProviderBoxReference('platinum', 'sbx_synthetic_foreign')).toBe(false);
  const result = await reapOrphanProviderBoxes(new Date('2026-09-27T12:00:00Z'));
  expect(result).toMatchObject({ listed: 1, orphans: 1, stopped: 1, errors: 0 });
  expect(stops).toEqual(['sbx_synthetic_orphan']);
  // The old client's exact filter cannot select boxes protected by the new marker.
  expect(fleet.filter((box: any) => box.metadata['kortix.managed'] === 'true').map((box) => box.id))
    .toEqual(['sbx_synthetic_legacy']);
});

test('stale stopped status and live turns remain referenced', async () => {
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(), sessionId: `ownership-${crypto.randomUUID()}`,
    accountId, projectId, externalId, provider: 'platinum', status: 'stopped',
    updatedAt: new Date('2026-01-01'), metadata: { activeTurns: { synthetic: { state: 'active' } } },
  });
  expect(await hasProviderBoxReference('platinum', externalId)).toBe(true);
  expect(await hasProviderBoxReference('daytona', externalId)).toBe(false);
  const marker = await sandboxOwnershipMarker();
  fleet = [externalId].map((id) => ({
    id, state: 'running', created_at: '2026-01-01T00:00:00Z',
    metadata: { 'kortix.managed': marker, 'kortix.env': config.INTERNAL_KORTIX_ENV },
  }));
  stops.length = 0;
  const result = await reapOrphanProviderBoxes();
  // Referenced, so the ORPHAN path never touches the box.
  expect(result.stopped).toBe(0);
  // But the session row says `stopped` while the provider lists its box
  // running: a row/VM divergence, and the reconciler closes it by stopping the
  // VM. The row's stale `activeTurns` does not protect it — a parked row holds
  // no turn authority by the platform's own predicate
  // (session-lifecycle/inbox-admission.ts, `sessionHoldsTurnAuthority`).
  expect(result.divergence).toEqual({ diverged: 1, closed: 1, errors: 0 });
  expect(stops).toEqual([externalId]);
});

test('corrupt ownership fails closed before provider listing', async () => {
  stops.length = 0;
  await db.update(platformSettings).set({ value: '' }).where(eq(platformSettings.key, 'sandbox_owner_id'));
  await expect(new PlatinumProvider().listManagedRunningSandboxes()).rejects.toThrow('Invalid sandbox_owner_id');
  expect(stops).toEqual([]);
});
