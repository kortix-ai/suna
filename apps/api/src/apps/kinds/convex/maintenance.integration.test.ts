import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  appConvexInstances,
  apps,
  creditAccounts,
  projectMembers,
  projects,
  sandboxComputeSessions,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { config } from '../../../config';
import { db } from '../../../shared/db';
import { app } from '../../../index';
import { createAccountToken } from '../../../repositories/account-tokens';
import { insertIntoView } from '../../../__tests__/helpers/compat-views';
import { decryptProjectSecret, encryptProjectSecret } from '../../../projects/surface';
import { MAX_PROVISION_ATTEMPTS, UNHEALTHY_ALERT_AFTER, sweepBackends } from './maintenance';
import {
  AUTOMATIC_SNAPSHOT_RETENTION_MS,
  BackendOperationError,
  MAX_MANUAL_SNAPSHOTS,
  RESIZE_SNAPSHOT_RETENTION_MS,
  claimOperation,
  createBackendSnapshot,
  restoreBackendSnapshot,
  rotateBackendAdminKey,
  runResize,
  runSnapshotMaintenance,
} from './operations';
import { type ConvexRow, discardMachine } from './provision';
import { insertConvexRow, readConvexRow } from '../../../__tests__/helpers/convex-apps';
import { backendPublicUrls } from './hosts';
import { ORPHAN_MACHINE_GRACE_MS, deleteAccountBackends, purgeRetiredConvexApps, reapOrphanBackendMachines } from './lifecycle';
import { sandboxOwnershipMarker } from '../../../platform/sandbox-ownership';

// The maintenance sweep of Apps of kind `convex`, admin-key rotation and the
// capability routes against the real DB, a fake Platinum API and a fake Convex. Proves:
// an interrupted provision resumes on the same machine (H6), an interrupted
// operation is recovered (H6), the probe records health and repairs a stopped,
// lost or tombstoned machine (H1), rotation re-seals the key Convex accepts
// (H4), the logs route returns the process log without color codes (L1), an
// archived project's backends park and come back (D9), account deletion
// deletes machines and snapshots (D9), orphaned machines are deleted (B5), and
// a running backend is metered (D11), and snapshots keep their kind, cap and
// expiry, run under the operation lock, and restore only once Platinum has
// restored (D22, H5, N2, N3). A delete keeps the stopped machine and a `final`
// snapshot until the retention ends, then purges it; the budget alerts once
// per threshold per month and never stops the machine.

type Machine = {
  state: string;
  recoverable?: boolean;
  cpu: number;
  ramMb: number;
  diskGb: number;
  secret: number;
  /** The instance secret on the disk a backup or snapshot restore brings back. */
  backupSecret?: number;
  autoResume?: boolean;
  snapshots?: string[];
  /** GETs a restore answers `resuming` before it ends. */
  restorePolls?: number;
  resumingLeft?: number;
  /** The state a restore ends in: `running` by default, `stopped` for a failed restore. */
  restoreEndsIn?: string;
  /** Listed by GET /v1/sandboxes; a machine without it is not listed. */
  metadata?: Record<string, unknown>;
  createdAt?: string;
  /** POST /snapshot holds the request this long before the host finishes (Platinum waits up to 180 s). */
  snapshotDelayMs?: number;
  /** POST /snapshot takes the snapshot, then answers this status (a gateway timeout in front of Platinum). */
  snapshotAnswers?: number;
  /** GET /snapshots answers after this long. */
  snapshotListDelayMs?: number;
};
const machines = new Map<string, Machine>();
const calls: string[] = [];
const listPages: string[] = [];
let convexDown = false;
/** Every rotation writes a secret no machine had before. */
let secretSeq = 100;

const keyFor = (id: string) => `synthetic|${id}-secret-${machines.get(id)?.secret ?? 0}`;
const machineOf = (path: string) => /^\/v1\/sandboxes\/([^/?]+)/.exec(path)?.[1] ?? '';
/** Machines whose DELETE answers 500. */
const failDelete = new Set<string>();
/** Machines whose POST /stop answers 500. */
const failStop = new Set<string>();
/** Snapshot creation times; a snapshot not listed here was taken 2026-10-07T00:00:00Z. */
const snapshotTimes = new Map<string, string>();
let snapshotSeq = 0;
/** Machines whose snapshot POST the client hung up on before Platinum answered. */
const abortedSnapshotPosts: string[] = [];

/** Machine ports exposed privately (POST /expose with public: false), by `<machine>:<port>`. */
const privatePorts = new Set<string>();
/** Origins each machine's Convex runs with (the last origins file written, once its restart script ran). */
const runningOrigins = new Map<string, string>();
const writtenOrigins = new Map<string, string>();
const edgeToken = (id: string) => `synthetic-edge-token-${id}`;

// One fake Convex per machine is overkill: every machine's URL is this one,
// tagged with the machine id in the path prefix. Like Platinum's edge, it
// refuses a request without the machine's private-exposure token.
const convex = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const [, id, ...rest] = url.pathname.split('/');
    const path = `/${rest.join('/')}`;
    if (req.headers.get('x-pt-preview-token') !== edgeToken(id!)) return new Response('token required', { status: 404 });
    if (convexDown) return new Response('down', { status: 503 });
    if (path === '/version') return new Response('unknown');
    if (path === '/api/check_admin_key') {
      return new Response(null, { status: req.headers.get('authorization') === `Convex ${keyFor(id!)}` ? 200 : 401 });
    }
    if (path === '/api/update_environment_variables') return new Response(null, { status: 200 });
    return new Response('not found', { status: 404 });
  },
});
const convexUrl = (id: string) => `http://127.0.0.1:${convex.port}/${id}`;

const platinum = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const id = machineOf(url.pathname);
    const sub = url.pathname.slice(`/v1/sandboxes/${id}`.length);
    calls.push(`${req.method} ${url.pathname}${req.headers.get('idempotency-key') ? ` key=${req.headers.get('idempotency-key')}` : ''}`);
    if (req.method === 'GET' && url.pathname === '/v1/sandboxes') {
      // Platinum's paginated list, two rows per page so the orphan pass pages.
      const listed = [...machines].filter(([, m]) => m.metadata && m.state !== 'deleted');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const page = listed.slice(offset, offset + 2);
      listPages.push(url.search);
      return Response.json({
        rows: page.map(([mid, m]) => ({ id: mid, state: m.state, metadata: m.metadata, created_at: m.createdAt })),
        has_more: offset + page.length < listed.length,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/sandboxes') {
      const body = (await req.json()) as { name: string };
      const newId = `sbx-${body.name}`;
      if (!machines.has(newId)) machines.set(newId, { state: 'running', cpu: 1, ramMb: 1024, diskGb: 10, secret: 1 });
      return Response.json({
        id: newId,
        state: 'running',
        exposed: ((body as { expose?: Array<{ port: number; public: boolean }> }).expose ?? []).map((e) => ({ port: e.port, public: e.public })),
      });
    }
    const m = machines.get(id);
    if (!m) return Response.json({ error: 'sandbox not found', code: 'sandbox_not_found' }, { status: 404 });
    if (req.method === 'GET' && sub === '') {
      if (m.state === 'deleted' && !m.recoverable) return Response.json({ code: 'sandbox_not_found' }, { status: 404 });
      // Platinum restores on the host after answering: `resuming` for a while, then the end state.
      if (m.state === 'resuming' && (m.resumingLeft = (m.resumingLeft ?? 0) - 1) < 0) m.state = m.restoreEndsIn ?? 'running';
      return Response.json({ ...m, ...(m.recoverable ? { recoverable: true } : {}) });
    }
    if (req.method === 'GET' && sub === '/usage') return Response.json({ disk_used_pct: 42 });
    if (req.method === 'POST' && sub === '/expose') {
      const body = (await req.json()) as { port: number; public: boolean };
      if (!body.public) privatePorts.add(`${id}:${body.port}`);
      return Response.json({ port: body.port, public: body.public, url: `${convexUrl(id)}?t=${edgeToken(id)}` });
    }
    if (req.method === 'GET' && sub === '/snapshots') {
      if (m.snapshotListDelayMs) await Bun.sleep(m.snapshotListDelayMs);
      return Response.json((m.snapshots ?? []).map((sid) => ({ id: sid, createdAt: snapshotTimes.get(sid) ?? '2026-10-07T00:00:00Z', sizeBytes: 1024 })));
    }
    if (req.method === 'POST' && sub === '/snapshot') {
      if (m.state !== 'running') return Response.json({ code: 'sandbox_not_running' }, { status: 409 });
      if (m.snapshotDelayMs) await Bun.sleep(m.snapshotDelayMs);
      if (req.signal.aborted) abortedSnapshotPosts.push(id);
      // The host finishes the snapshot whether or not the caller still waits.
      const sid = `snap-${++snapshotSeq}`;
      m.snapshots = [...(m.snapshots ?? []), sid];
      snapshotTimes.set(sid, new Date().toISOString());
      if (m.snapshotAnswers) return Response.json({ error: 'synthetic gateway timeout' }, { status: m.snapshotAnswers });
      return Response.json({ id: sid, sandbox_id: id, size_bytes: 1024 });
    }
    if (req.method === 'POST' && sub === '/resize') {
      const body = (await req.json()) as { cpu: number; ram_mb: number; disk_gb: number };
      Object.assign(m, { cpu: body.cpu, ramMb: body.ram_mb, diskGb: body.disk_gb, state: 'running' });
      return Response.json({ state: 'running' });
    }
    if (req.method === 'DELETE' && sub.startsWith('/snapshots/')) {
      m.snapshots = (m.snapshots ?? []).filter((sid) => sid !== sub.slice('/snapshots/'.length));
      return Response.json({ deleted: true });
    }
    if (req.method === 'PATCH' && sub === '') {
      m.autoResume = ((await req.json()) as { auto_resume: boolean }).auto_resume;
      return Response.json(m);
    }
    if (req.method === 'POST' && sub === '/stop') {
      if (failStop.has(id)) return Response.json({ error: 'synthetic failure' }, { status: 500 });
      if (m.state !== 'running') return Response.json({ code: 'sandbox_not_running' }, { status: 409 });
      m.state = 'stopped';
      return Response.json({ state: 'stopping' });
    }
    if (req.method === 'PUT' && sub.startsWith('/files')) {
      if (url.searchParams.get('path') === '/convex/origins.env') writtenOrigins.set(id, await req.text());
      return Response.json({ ok: true });
    }
    if (req.method === 'POST' && sub === '/start') {
      m.state = 'running';
      return Response.json({ state: 'running' });
    }
    if (req.method === 'POST' && sub === '/restore-from-backup') {
      m.state = 'running';
      m.recoverable = false;
      m.secret = m.backupSecret ?? m.secret;
      return Response.json({ state: 'restoring' });
    }
    if (req.method === 'POST' && sub === '/restore') {
      if (m.state !== 'running') return Response.json({ code: 'sandbox_not_running' }, { status: 409 });
      m.secret = m.backupSecret ?? m.secret;
      m.state = 'resuming';
      m.resumingLeft = m.restorePolls ?? 0;
      return Response.json({ state: 'resuming' });
    }
    if (req.method === 'DELETE' && sub === '') {
      if (failDelete.has(id)) return Response.json({ error: 'synthetic failure' }, { status: 500 });
      machines.delete(id);
      return Response.json({ ok: true });
    }
    if (req.method === 'POST' && sub === '/exec') {
      const script = ((await req.json()) as { cmd: string[] }).cmd[2]!;
      if (script.includes('generate_admin_key.sh')) return Response.json({ result: { exit_code: 0, stdout: `Admin key:\n${keyFor(id)}\n` } });
      if (script.includes('instance_secret.next')) {
        m.secret = ++secretSeq;
        return Response.json({ result: { exit_code: 0, stdout: '' } });
      }
      if (script.includes('--convex-origin')) {
        const want = /--convex-origin (\S+) /.exec(script)![1]!;
        if (runningOrigins.get(id) === want) return Response.json({ result: { exit_code: 0, stdout: 'unchanged\n' } });
        runningOrigins.set(id, /CONVEX_CLOUD_ORIGIN=(\S+)/.exec(writtenOrigins.get(id) ?? '')?.[1] ?? '');
        return Response.json({ result: { exit_code: 0, stdout: 'restarted\n' } });
      }
      if (script.includes('tail -n')) {
        return Response.json({ result: { exit_code: 0, stdout: `\u001b[32m INFO\u001b[0m started (${script.match(/tail -n (\d+)/)![1]} lines)\nconvex exited 1 at 1700000000\n` } });
      }
      return Response.json({ result: { exit_code: 1, stderr: 'unknown script' } });
    }
    return Response.json({ error: `unhandled ${req.method} ${url.pathname}` }, { status: 500 });
  },
});

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ARCHIVED_PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
let secret = '';
let tokenId = '';
const saved = { key: config.PLATINUM_API_KEY, url: config.PLATINUM_API_URL };

beforeAll(async () => {
  config.PLATINUM_API_KEY = 'pt_synthetic_backend_maintenance';
  config.PLATINUM_API_URL = `http://127.0.0.1:${platinum.port}`;
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'backend-maintenance-test' });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'backend-maintenance', repoUrl: 'https://example.com/bm.git', metadata: { experimental: { apps: true } } },
    { projectId: ARCHIVED_PROJECT, accountId: ACCOUNT, name: 'backend-maintenance-archived', repoUrl: 'https://example.com/bma.git', status: 'archived' },
  ]);
  await insertIntoView(db, accountMembers, { userId: USER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
  await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: USER, projectRole: 'manager' });
  const token = await createAccountToken({ accountId: ACCOUNT, userId: USER, name: 'backend-maintenance-test' });
  tokenId = token.tokenId;
  secret = token.secretKey;
});

afterAll(async () => {
  config.PLATINUM_API_KEY = saved.key;
  config.PLATINUM_API_URL = saved.url;
  await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(apps).where(eq(apps.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  platinum.stop(true);
  convex.stop(true);
});

const ago = (ms: number) => new Date(Date.now() - ms);

/** A running `convex` App on machine `sbx-<name>`, holding that machine's current admin key. */
async function runningBackend(name: string, machine: Partial<Machine>, extra: Partial<ConvexRow> = {}): Promise<ConvexRow> {
  const externalId = `sbx-${name}`;
  machines.set(externalId, { state: 'running', cpu: 1, ramMb: 1024, diskGb: 10, secret: 1, ...machine });
  const appId = extra.appId ?? crypto.randomUUID();
  return insertConvexRow({
    appId,
    projectId: PROJECT,
    accountId: ACCOUNT,
    slug: name,
    status: 'running',
    externalId,
    // Already on its Kortix hosts; `legacy-hosts` below starts on Platinum URLs.
    url: backendPublicUrls(appId).url,
    siteUrl: backendPublicUrls(appId).siteUrl,
    adminKeyEnc: encryptProjectSecret(extra.projectId ?? PROJECT, keyFor(externalId)),
    ...extra,
  } as Parameters<typeof insertConvexRow>[0]);
}

/** A `convex` App row in any state (no machine yet unless `externalId`). */
const seedRow = (seed: Omit<Parameters<typeof insertConvexRow>[0], 'projectId' | 'accountId'> & { projectId?: string; accountId?: string }) =>
  insertConvexRow({ projectId: PROJECT, accountId: ACCOUNT, ...seed });

const read = async (appId: string) => (await readConvexRow(appId))!;
const meta = (row: ConvexRow) => row.metadata as Record<string, any>;

async function eventually<T>(fn: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(value).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('resume an interrupted provision (H6)', () => {
  test('a provisioning row with no heartbeat for 2 min resumes on the same Idempotency-Key and reaches running', async () => {
    const row = await seedRow({ slug: 'resumed', status: 'provisioning', createdAt: ago(5 * 60_000) });
    const fresh = (
      [await seedRow({ slug: 'still-building', status: 'provisioning', createdAt: ago(20 * 60_000), metadata: { heartbeatAt: ago(10_000).toISOString() } })]
    )[0]!;
    const result = await sweepBackends();
    expect(result.resumed).toBe(1);
    const done = await eventually(() => read(row.appId), (r) => r.status === 'running');
    expect(done.externalId).toBe(`sbx-backend-${row.appId}`);
    expect(decryptProjectSecret(PROJECT, done.adminKeyEnc!)).toBe(keyFor(done.externalId!));
    expect(meta(done).provisionAttempts).toBe(2);
    // A new App is born on its Kortix hosts, with Convex running on them.
    expect(done.url).toBe(backendPublicUrls(done.appId).url);
    expect(done.siteUrl).toBe(backendPublicUrls(done.appId).siteUrl);
    expect(writtenOrigins.get(done.externalId!)).toContain(`CONVEX_CLOUD_ORIGIN=${done.url}\n`);
    expect(writtenOrigins.get(done.externalId!)).toContain(`CONVEX_SITE_ORIGIN=${done.siteUrl}\n`);
    expect(calls).toContain(`POST /v1/sandboxes key=kortix-backend-${row.appId}`);
    // A provision that heartbeats is left alone, however old the row.
    expect((await read(fresh.appId)).status).toBe('provisioning');
    expect(meta(await read(fresh.appId)).provisionAttempts).toBeUndefined();
  });

  test(`a provision interrupted ${MAX_PROVISION_ATTEMPTS} times turns error and its machine is deleted`, async () => {
    machines.set('sbx-abandoned', { state: 'running', cpu: 1, ramMb: 1024, diskGb: 10, secret: 1 });
    const row = await seedRow({ slug: 'abandoned', status: 'provisioning', externalId: 'sbx-abandoned', createdAt: ago(60 * 60_000), metadata: { provisionAttempts: MAX_PROVISION_ATTEMPTS, heartbeatAt: ago(5 * 60_000).toISOString() } });
    const result = await sweepBackends();
    expect(result.failedProvisions).toBe(1);
    const after = await read(row.appId);
    expect(after.status).toBe('error');
    expect(meta(after).lastError).toContain(`interrupted ${MAX_PROVISION_ATTEMPTS} times`);
    expect(machines.has('sbx-abandoned')).toBe(false);
  });
});

describe('take over an interrupted operation (H6)', () => {
  test('a resize whose process died: the stopped machine is started, the size read back, the marker cleared with a reason', async () => {
    const row = await runningBackend('resize-died', { state: 'stopped', cpu: 2, ramMb: 4096, diskGb: 20 }, {
      metadata: { operation: 'resizing', operationStartedAt: ago(10 * 60_000).toISOString(), heartbeatAt: ago(3 * 60_000).toISOString() },
    });
    const result = await sweepBackends();
    expect(result.recovered).toBe(1);
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation);
    expect(machines.get('sbx-resize-died')!.state).toBe('running');
    expect([after.cpu, after.memoryGb, after.diskGb]).toEqual([2, 4, 20]);
    expect(meta(after).lastOperationError).toBe('The resize was interrupted. The App runs again; retry it.');
    expect(meta(after).heartbeatAt).toBeUndefined();
  });

  test('a resize that still heartbeats is not touched', async () => {
    const row = await runningBackend('resize-alive', { state: 'stopped' }, {
      metadata: { operation: 'resizing', operationStartedAt: ago(10 * 60_000).toISOString(), heartbeatAt: ago(5_000).toISOString() },
    });
    await sweepBackends();
    expect(meta(await read(row.appId)).operation).toBe('resizing');
    expect(machines.get('sbx-resize-alive')!.state).toBe('stopped');
  });
});

describe('Kortix hosts', () => {
  test('a backend on its Platinum URLs moves to its Kortix hosts: new Convex origins, private ports, new URLs; a second sweep changes nothing', async () => {
    const row = await runningBackend('legacy-hosts', {}, { url: 'https://3210-sbx-legacy-hosts.example', siteUrl: 'https://3211-sbx-legacy-hosts.example' });
    runningOrigins.set('sbx-legacy-hosts', 'https://3210-sbx-legacy-hosts.example');
    const result = await sweepBackends();
    expect(result.movedToHosts).toBe(1);
    const after = await read(row.appId);
    const hosts = backendPublicUrls(row.appId);
    expect({ url: after.url, siteUrl: after.siteUrl }).toEqual({ url: hosts.url, siteUrl: hosts.siteUrl });
    expect(runningOrigins.get('sbx-legacy-hosts')).toBe(hosts.url);
    expect([3210, 3211, 6791].filter((port) => privatePorts.has(`sbx-legacy-hosts:${port}`))).toEqual([3210, 3211, 6791]);
    expect(meta(after).operation).toBeUndefined();
    expect(meta(after).health).toMatchObject({ ok: true, machine_state: 'running' });

    expect((await sweepBackends()).movedToHosts).toBe(0);
    expect((await read(row.appId)).url).toBe(hosts.url);
  });

  test('a move that fails leaves the backend on its old URLs, unlocked, for the next tick', async () => {
    const row = await runningBackend('legacy-down', {}, { url: 'https://3210-sbx-legacy-down.example', siteUrl: 'https://3211-sbx-legacy-down.example' });
    machines.delete('sbx-legacy-down');
    const result = await sweepBackends();
    expect(result.movedToHosts).toBe(0);
    const after = await read(row.appId);
    expect(after.url).toBe('https://3210-sbx-legacy-down.example');
    expect(meta(after).operation).not.toBe('recovering');
    await db.update(appConvexInstances).set({ status: 'deleted' }).where(eq(appConvexInstances.appId, row.appId));
    await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.appId, row.appId));
  });
});

describe('health probe (H1)', () => {
  test('a healthy backend records ok, the machine state and disk use', async () => {
    const row = await runningBackend('healthy', {});
    await sweepBackends();
    const health = meta(await read(row.appId)).health;
    expect(health).toMatchObject({ ok: true, machine_state: 'running', failures: 0, error: null, disk_used_pct: 42, repair: null });
  });

  test('Convex not answering counts failures in a row; the status stays running', async () => {
    const row = await runningBackend('convex-down', {});
    convexDown = true;
    try {
      await sweepBackends();
      await sweepBackends();
    } finally {
      convexDown = false;
    }
    const after = await read(row.appId);
    expect(after.status).toBe('running');
    expect(meta(after).health).toMatchObject({ ok: false, machine_state: 'running', failures: 2, error: 'Convex answered HTTP 503' });
    await sweepBackends();
    expect(meta(await read(row.appId)).health).toMatchObject({ ok: true, failures: 0 });
  });

  test('a stopped machine is started and the admin key re-sealed', async () => {
    const row = await runningBackend('stopped', { state: 'stopped' });
    const result = await sweepBackends();
    expect(result.repairs).toBeGreaterThanOrEqual(1);
    expect(meta(await read(row.appId)).health).toMatchObject({ ok: false, machine_state: 'stopped', repair: 'started' });
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation);
    expect(machines.get('sbx-stopped')!.state).toBe('running');
    expect(meta(after).lastOperationError).toBeUndefined();
    await sweepBackends();
    expect(meta(await read(row.appId)).health).toMatchObject({ ok: true, machine_state: 'running' });
  });

  test('a system-tombstoned machine with a backup is restored from it; the restored secret is the one Kortix seals', async () => {
    const row = await runningBackend('tombstoned', { state: 'deleted', recoverable: true });
    // The backup predates a rotation: the machine comes back on an older secret.
    machines.get('sbx-tombstoned')!.secret = 7;
    await sweepBackends();
    expect(meta(await read(row.appId)).health).toMatchObject({ machine_state: 'tombstoned', repair: 'restored_from_backup' });
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation);
    expect(calls).toContain('POST /v1/sandboxes/sbx-tombstoned/restore-from-backup');
    expect(decryptProjectSecret(PROJECT, after.adminKeyEnc!)).toBe('synthetic|sbx-tombstoned-secret-7');
  });

  test(`a machine Platinum no longer has turns the row error after ${UNHEALTHY_ALERT_AFTER} probes`, async () => {
    const row = await runningBackend('gone', {});
    machines.delete('sbx-gone');
    for (let i = 1; i < UNHEALTHY_ALERT_AFTER; i += 1) {
      await sweepBackends();
      expect((await read(row.appId)).status).toBe('running');
    }
    await sweepBackends();
    const after = await read(row.appId);
    expect(after.status).toBe('error');
    expect(meta(after).health).toMatchObject({ ok: false, machine_state: 'missing', failures: UNHEALTHY_ALERT_AFTER });
    expect(meta(after).lastError).toContain('no longer exists');
  });

  test("an archived project's stopped backend is not probed or started; it is parked", async () => {
    const row = await runningBackend('archived', { state: 'stopped' }, { projectId: ARCHIVED_PROJECT });
    await sweepBackends();
    const after = await read(row.appId);
    expect(meta(after).health).toBeUndefined();
    expect(typeof meta(after).parked).toBe('string');
    expect(machines.get('sbx-archived')).toMatchObject({ state: 'stopped', autoResume: false });
  });
});

describe('admin-key rotation (H4)', () => {
  test('rotation changes the secret, seals the key Convex now accepts, and clears the marker', async () => {
    const row = await runningBackend('rotate', {});
    const before = keyFor('sbx-rotate');
    await rotateBackendAdminKey(row);
    const after = await read(row.appId);
    const sealed = decryptProjectSecret(PROJECT, after.adminKeyEnc!);
    expect(sealed).not.toBe(before);
    expect(sealed).toBe(keyFor('sbx-rotate'));
    expect(meta(after).operation).toBeUndefined();
    expect(meta(after).lastOperationError).toBeUndefined();
  });

  test('a restore from a backup taken before the rotation rotates again: the leaked key never comes back', async () => {
    const row = await runningBackend('rotate-restore', {});
    const leaked = keyFor('sbx-rotate-restore');
    await rotateBackendAdminKey(row);
    expect(typeof meta(await read(row.appId)).adminKeyRotatedAt).toBe('string');
    // The host is lost before the next hourly backup: the backup still holds the old secret.
    Object.assign(machines.get('sbx-rotate-restore')!, { state: 'deleted', recoverable: true, backupSecret: 1 });
    await sweepBackends();
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation);
    expect(calls).toContain('POST /v1/sandboxes/sbx-rotate-restore/restore-from-backup');
    expect(keyFor('sbx-rotate-restore')).not.toBe(leaked);
    expect(decryptProjectSecret(PROJECT, after.adminKeyEnc!)).toBe(keyFor('sbx-rotate-restore'));
  });

  test('a snapshot restore after a rotation rotates again', async () => {
    const row = await runningBackend('rotate-snapshot', { snapshots: ['snap-old'] });
    const leaked = keyFor('sbx-rotate-snapshot');
    await rotateBackendAdminKey(row);
    machines.get('sbx-rotate-snapshot')!.backupSecret = 1;
    await restoreBackendSnapshot(await read(row.appId), 'snap-old');
    expect(keyFor('sbx-rotate-snapshot')).not.toBe(leaked);
    expect(decryptProjectSecret(PROJECT, (await read(row.appId)).adminKeyEnc!)).toBe(keyFor('sbx-rotate-snapshot'));
  });

  test('a rotation during another operation answers backend_busy and changes nothing', async () => {
    const row = await runningBackend('rotate-busy', {});
    expect(await claimOperation(row.appId, 'resizing')).toBe(true);
    const error = await rotateBackendAdminKey(row).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendOperationError);
    expect((error as BackendOperationError).code).toBe('app_busy');
    expect(machines.get('sbx-rotate-busy')!.secret).toBe(1);
  });
});

describe('routes', () => {
  const call = (method: string, path: string) =>
    app.request(`/v1/projects/${PROJECT}/apps${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });

  test('POST /rotate-credentials: the old key stops matching, credentials return the new one', async () => {
    const row = await runningBackend('route-rotate', {});
    const before = (await (await call('GET', `/${row.appId}/credentials`)).json()).admin_key;
    const res = await call('POST', `/${row.appId}/rotate-credentials`);
    expect(res.status).toBe(200);
    expect((await res.json()).instance.operation).toBeNull();
    const now = (await (await call('GET', `/${row.appId}/credentials`)).json()).admin_key;
    expect(now).not.toBe(before);
    expect(now).toBe(keyFor('sbx-route-rotate'));
  });

  test('GET /logs: the tail without color codes, no-store; lines out of range → 400', async () => {
    const row = await runningBackend('route-logs', {});
    const res = await call('GET', `/${row.appId}/logs?lines=50`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).log).toBe(' INFO started (50 lines)\nconvex exited 1 at 1700000000\n');
    expect((await call('GET', `/${row.appId}/logs?lines=0`)).status).toBe(400);
    expect((await call('GET', `/${row.appId}/logs?lines=1001`)).status).toBe(400);
  });

  test('GET the App carries kind, capabilities and its last health probe', async () => {
    const row = await runningBackend('route-health', {});
    const before = await (await call('GET', `/${row.appId}`)).json();
    expect(before).toMatchObject({ kind: 'convex', url: backendPublicUrls(row.appId).url, always_on: true });
    expect(before.capabilities).toEqual(['deployments', 'snapshots', 'restore', 'admin_credentials', 'dashboard', 'logs', 'member_tokens']);
    expect(before.instance.health).toBeNull();
    await sweepBackends();
    const { instance } = await (await call('GET', `/${row.appId}`)).json();
    expect(instance.health).toMatchObject({ ok: true, machine_state: 'running', disk_used_pct: 42 });
  });
});

describe('archive and unarchive (D9)', () => {
  test('a running backend of an archived project is parked once: auto-resume off, stopped, marked', async () => {
    const row = await runningBackend('park-me', { autoResume: true }, { projectId: ARCHIVED_PROJECT });
    const result = await sweepBackends();
    expect(result.parked).toBeGreaterThanOrEqual(1);
    expect(machines.get('sbx-park-me')).toMatchObject({ state: 'stopped', autoResume: false });
    const after = await read(row.appId);
    expect(Date.parse(meta(after).parked)).toBeGreaterThan(Date.now() - 60_000);
    expect(meta(after).health).toBeUndefined();
    await sweepBackends();
    expect(calls.filter((c) => c === 'POST /v1/sandboxes/sbx-park-me/stop')).toHaveLength(1);
    expect(calls.filter((c) => c === 'PATCH /v1/sandboxes/sbx-park-me')).toHaveLength(1);
  });

  test('a project active again: auto-resume back on, marker cleared, the probe starts the machine', async () => {
    const project = crypto.randomUUID();
    await db.insert(projects).values({ projectId: project, accountId: ACCOUNT, name: 'unarchive', repoUrl: 'https://example.com/u.git', status: 'archived' });
    const row = await runningBackend('unpark-me', { autoResume: true }, { projectId: project });
    await sweepBackends();
    expect(machines.get('sbx-unpark-me')).toMatchObject({ state: 'stopped', autoResume: false });
    await db.update(projects).set({ status: 'active' }).where(eq(projects.projectId, project));
    const result = await sweepBackends();
    expect(result.unparked).toBe(1);
    expect(machines.get('sbx-unpark-me')!.autoResume).toBe(true);
    const after = await eventually(
      () => read(row.appId),
      (r) => !meta(r).operation && machines.get('sbx-unpark-me')!.state === 'running',
    );
    expect(meta(after).parked).toBeUndefined();
    expect(after.status).toBe('running');
  });
});

describe('account deletion (D9)', () => {
  test('every backend of the account: snapshots deleted, then the machine, then the row retired; other accounts untouched', async () => {
    const account = crypto.randomUUID();
    const project = crypto.randomUUID();
    await db.insert(accounts).values({ accountId: account, name: 'backend-account-deletion' });
    await db.insert(projects).values({ projectId: project, accountId: account, name: 'gone', repoUrl: 'https://example.com/g.git' });
    const row = await runningBackend('account-gone', { snapshots: ['snap-a', 'snap-b'] }, { projectId: project, accountId: account });
    const survivor = await runningBackend('account-stays', {});
    expect(await deleteAccountBackends(account)).toBe(1);
    expect(calls).toContain('DELETE /v1/sandboxes/sbx-account-gone/snapshots/snap-a');
    expect(calls).toContain('DELETE /v1/sandboxes/sbx-account-gone/snapshots/snap-b');
    expect(calls.indexOf('DELETE /v1/sandboxes/sbx-account-gone')).toBeGreaterThan(
      calls.indexOf('DELETE /v1/sandboxes/sbx-account-gone/snapshots/snap-b'),
    );
    expect(machines.has('sbx-account-gone')).toBe(false);
    expect(await readConvexRow(row.appId)).toBeUndefined();
    expect((await db.select({ deletedAt: apps.deletedAt }).from(apps).where(eq(apps.appId, row.appId)))[0]!.deletedAt).not.toBeNull();
    expect(machines.has('sbx-account-stays')).toBe(true);
    expect((await read(survivor.appId)).deletedAt).toBeNull();
  });

  test('a machine delete that fails throws, so account deletion stops and retries', async () => {
    const account = crypto.randomUUID();
    const project = crypto.randomUUID();
    await db.insert(accounts).values({ accountId: account, name: 'backend-account-deletion-fail' });
    await db.insert(projects).values({ projectId: project, accountId: account, name: 'stuck', repoUrl: 'https://example.com/s.git' });
    const row = await runningBackend('account-stuck', {}, { projectId: project, accountId: account });
    failDelete.add('sbx-account-stuck');
    try {
      await expect(deleteAccountBackends(account)).rejects.toThrow();
      expect((await read(row.appId)).deletedAt).toBeNull();
    } finally {
      failDelete.delete('sbx-account-stuck');
    }
    expect(await deleteAccountBackends(account)).toBe(1);
  });
});

describe('orphaned machines (B5)', () => {
  test('a failed delete after a failed provision is recorded, then retried by the sweep', async () => {
    machines.set('sbx-pending', { state: 'running', cpu: 1, ramMb: 1024, diskGb: 10, secret: 1 });
    failDelete.add('sbx-pending');
    const backendId = crypto.randomUUID();
    expect(await discardMachine(backendId, 'sbx-pending')).toEqual({ machineDeletePending: true });
    failDelete.delete('sbx-pending');
    const row = await seedRow({ appId: backendId, slug: 'pending', status: 'error', externalId: 'sbx-pending', metadata: { lastError: 'x', machineDeletePending: true } });
    const result = await sweepBackends();
    expect(result.machinesDeleted).toBeGreaterThanOrEqual(1);
    expect(machines.has('sbx-pending')).toBe(false);
    expect(meta(await read(row.appId)).machineDeletePending).toBeUndefined();
  });

  test('every page, every state: old unreferenced machines go with their snapshots; young, referenced and foreign ones stay', async () => {
    const owner = await sandboxOwnershipMarker();
    const tag = (backendId: string, managed = owner) => ({ 'kortix.managed': managed, 'kortix.workload': 'backend', 'kortix.backend_id': backendId });
    const old = new Date(Date.now() - 2 * ORPHAN_MACHINE_GRACE_MS).toISOString();
    const base = { cpu: 1, ramMb: 1024, diskGb: 10, secret: 1 };
    // Referenced by a live running row: kept.
    const kept = await runningBackend('orphan-kept', {});
    Object.assign(machines.get('sbx-orphan-kept')!, { metadata: tag(kept.appId), createdAt: old });
    // No row at all, stopped, with a snapshot: deleted.
    machines.set('sbx-orphan-rowless', { ...base, state: 'stopped', snapshots: ['snap-o'], metadata: tag(crypto.randomUUID()), createdAt: old });
    // No row, but younger than the grace: kept.
    machines.set('sbx-orphan-young', { ...base, state: 'running', metadata: tag(crypto.randomUUID()), createdAt: new Date().toISOString() });
    // A deleted App in retention still owns its stopped machine: kept (the purge deletes it).
    const deleted = await seedRow({ slug: 'orphan-deleted', status: 'deleted', externalId: 'sbx-orphan-deleted', deletedAt: new Date() });
    machines.set('sbx-orphan-deleted', { ...base, state: 'running', metadata: tag(deleted.appId), createdAt: old });
    // A second machine for a running row that references another one: deleted.
    machines.set('sbx-orphan-duplicate', { ...base, state: 'running', metadata: tag(kept.appId), createdAt: old });
    // A provisioning row owns its machine before it records the id: kept.
    const provisioning = await seedRow({ slug: 'orphan-provisioning', status: 'provisioning', metadata: { heartbeatAt: new Date().toISOString() } });
    machines.set('sbx-orphan-provisioning', { ...base, state: 'running', metadata: tag(provisioning.appId), createdAt: old });
    // Another control plane's machine: never ours to delete.
    machines.set('sbx-orphan-foreign', { ...base, state: 'running', metadata: tag(crypto.randomUUID(), 'v2-another-database'), createdAt: old });
    listPages.length = 0;

    const result = await reapOrphanBackendMachines({ force: true });

    expect(result).toMatchObject({ deleted: 2, errors: 0 });
    expect(listPages.length).toBeGreaterThanOrEqual(4);
    for (const search of listPages) expect(search).toContain('regions=local');
    for (const gone of ['sbx-orphan-rowless', 'sbx-orphan-duplicate']) expect(machines.has(gone)).toBe(false);
    expect(calls).toContain('DELETE /v1/sandboxes/sbx-orphan-rowless/snapshots/snap-o');
    for (const stays of ['sbx-orphan-kept', 'sbx-orphan-young', 'sbx-orphan-deleted', 'sbx-orphan-provisioning', 'sbx-orphan-foreign']) {
      expect(machines.has(stays)).toBe(true);
    }
    // At most once an hour without `force`.
    expect((await reapOrphanBackendMachines()).listed).toBe(0);
  });
});

describe('metering (D11)', () => {
  test('a running backend opens one backend window at its size and records liveness; parking closes it', async () => {
    const account = crypto.randomUUID();
    const project = crypto.randomUUID();
    await db.insert(accounts).values({ accountId: account, name: 'backend-metering' });
    await db.insert(creditAccounts).values({ accountId: account, billingModel: 'per_seat', tier: 'free', balance: '100', nonExpiringCredits: '100' });
    await db.insert(projects).values({ projectId: project, accountId: account, name: 'metered', repoUrl: 'https://example.com/m.git' });
    const row = await runningBackend('metered', {}, { projectId: project, accountId: account, cpu: 2, memoryGb: 4, diskGb: 20 });
    const saved = config.KORTIX_BILLING_INTERNAL_ENABLED;
    config.KORTIX_BILLING_INTERNAL_ENABLED = true;
    try {
      const windows = () => db.select().from(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, row.appId));
      await sweepBackends();
      await sweepBackends();
      const open = await windows();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ workloadType: 'backend', provider: 'platinum', state: 'active', cpuCores: 2, memoryGb: 4, diskGb: 20, endedAt: null });
      expect(Date.parse((open[0]!.metadata as { lastAliveAt: string }).lastAliveAt)).toBeGreaterThan(Date.now() - 60_000);
      await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, project));
      await sweepBackends();
      const closed = await windows();
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({ state: 'stopped' });
      expect(closed[0]!.endedAt).not.toBeNull();
    } finally {
      config.KORTIX_BILLING_INTERNAL_ENABLED = saved;
    }
  });
});

describe('snapshots (D22, H5, N2, N3)', () => {
  const route = (method: string, path: string, body?: unknown) =>
    app.request(`/v1/projects/${PROJECT}/apps${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : method === 'POST' ? { body: '{}' } : {}),
    });
  const errorCode = (error: unknown) => (error as BackendOperationError).code;
  const getsOf = (id: string) => calls.filter((c) => c === `GET /v1/sandboxes/${id}`).length;

  test(`a manual snapshot is labelled manual with no expiry; the ${MAX_MANUAL_SNAPSHOTS + 1}th answers snapshot_limit and nothing is dropped`, async () => {
    const row = await runningBackend('snap-cap', {});
    const first = await createBackendSnapshot(row);
    expect(first).toMatchObject({ kind: 'manual', expires_at: null, size_bytes: 1024 });
    for (let i = 1; i < MAX_MANUAL_SNAPSHOTS; i += 1) await createBackendSnapshot(await read(row.appId));
    const held = [...machines.get('sbx-snap-cap')!.snapshots!];
    expect(held).toHaveLength(MAX_MANUAL_SNAPSHOTS);
    const error = await createBackendSnapshot(await read(row.appId)).catch((e: unknown) => e);
    expect(errorCode(error)).toBe('snapshot_limit');
    expect(machines.get('sbx-snap-cap')!.snapshots).toEqual(held);
    expect(calls.filter((c) => c.startsWith('DELETE /v1/sandboxes/sbx-snap-cap/snapshots/'))).toHaveLength(0);
    expect(meta(await read(row.appId)).operation).toBeUndefined();
  });

  test('snapshot, restore and snapshot delete answer backend_busy during another operation (H5)', async () => {
    const row = await runningBackend('snap-busy', { snapshots: ['snap-busy-1'] });
    expect(await claimOperation(row.appId, 'resizing')).toBe(true);
    const busy = await read(row.appId);
    expect(errorCode(await createBackendSnapshot(busy).catch((e: unknown) => e))).toBe('app_busy');
    expect(errorCode(await restoreBackendSnapshot(busy, 'snap-busy-1').catch((e: unknown) => e))).toBe('app_busy');
    const del = await route('DELETE', `/${row.appId}/snapshots/snap-busy-1`);
    expect(del.status).toBe(409);
    expect((await del.json()).code).toBe('app_busy');
    const delBackend = await route('DELETE', `/${row.appId}?confirm=snap-busy`);
    expect(delBackend.status).toBe(409);
    expect((await delBackend.json()).code).toBe('app_busy');
    expect(machines.has('sbx-snap-busy')).toBe(true);
    expect(calls).not.toContain('POST /v1/sandboxes/sbx-snap-busy/snapshot');
    expect(calls).not.toContain('POST /v1/sandboxes/sbx-snap-busy/restore');
  });

  test('two concurrent snapshot requests: one runs, the other answers backend_busy', async () => {
    const row = await runningBackend('snap-race', {});
    const results = await Promise.allSettled([createBackendSnapshot(row), createBackendSnapshot(row)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(errorCode(rejected.reason)).toBe('app_busy');
  });

  test('a restore answers only after Platinum reports running again (N3)', async () => {
    const row = await runningBackend('snap-n3', { snapshots: ['snap-n3-1'], restorePolls: 3 });
    const before = getsOf('sbx-snap-n3');
    await restoreBackendSnapshot(row, 'snap-n3-1');
    expect(machines.get('sbx-snap-n3')!.state).toBe('running');
    // 3 polls answered `resuming`, the 4th `running`.
    expect(getsOf('sbx-snap-n3') - before).toBeGreaterThanOrEqual(4);
    expect(meta(await read(row.appId)).operation).toBeUndefined();
  });

  test('a restore that Platinum ends stopped answers restore_unhealthy; recovery starts the machine', async () => {
    const row = await runningBackend('snap-fail', { snapshots: ['snap-fail-1'], restorePolls: 1, restoreEndsIn: 'stopped' });
    const error = await restoreBackendSnapshot(row, 'snap-fail-1').catch((e: unknown) => e);
    expect(errorCode(error)).toBe('restore_unhealthy');
    expect(calls).toContain('POST /v1/sandboxes/sbx-snap-fail/start');
    expect(machines.get('sbx-snap-fail')!.state).toBe('running');
    const after = await read(row.appId);
    expect(meta(after).operation).toBeUndefined();
    expect(meta(after).lastOperationError).toContain('restore failed');
  });

  test('a resize takes a resize snapshot kept 24 h outside the cap; a snapshot older than the resize cannot be restored (N2)', async () => {
    const row = await runningBackend('snap-resize', { snapshots: ['snap-before'] });
    snapshotTimes.set('snap-before', new Date(Date.now() - 60_000).toISOString());
    expect(await claimOperation(row.appId, 'resizing')).toBe(true);
    await runResize(await read(row.appId), { cpu: 2, memoryGb: 2, diskGb: 20 });
    const after = await read(row.appId);
    expect([after.cpu, after.memoryGb, after.diskGb]).toEqual([2, 2, 20]);
    expect(meta(after).operation).toBeUndefined();
    expect(typeof meta(after).lastResizeAt).toBe('string');
    const labels = meta(after).snapshotLabels as Record<string, { kind: string; expiresAt: string }>;
    const [resizeId, label] = Object.entries(labels)[0]!;
    expect(label.kind).toBe('resize');
    expect(Math.abs(Date.parse(label.expiresAt) - (Date.now() + RESIZE_SNAPSHOT_RETENTION_MS))).toBeLessThan(60_000);
    // The user's snapshot survived the resize.
    expect(machines.get('sbx-snap-resize')!.snapshots).toEqual(['snap-before', resizeId]);

    for (const id of ['snap-before', resizeId]) {
      const error = await restoreBackendSnapshot(after, id).catch((e: unknown) => e);
      expect(errorCode(error)).toBe('snapshot_predates_resize');
    }
    expect(calls).not.toContain('POST /v1/sandboxes/sbx-snap-resize/restore');
    // A snapshot at the new size restores.
    const fresh = await createBackendSnapshot(await read(row.appId));
    await restoreBackendSnapshot(await read(row.appId), fresh.snapshot_id);
    expect(calls).toContain('POST /v1/sandboxes/sbx-snap-resize/restore');

    const listed = await (await route('GET', `/${row.appId}/snapshots`)).json();
    expect(listed.snapshot_limit).toBe(MAX_MANUAL_SNAPSHOTS);
    expect(listed.snapshot_schedule).toEqual({ automatic_interval_hours: 24, automatic_retention_days: 7, resize_retention_hours: 24, last_automatic_at: null });
    const kinds = Object.fromEntries(listed.snapshots.map((s: { snapshot_id: string; kind: string; expires_at: string | null }) => [s.snapshot_id, [s.kind, s.expires_at === null]]));
    expect(kinds).toEqual({ 'snap-before': ['manual', true], [resizeId]: ['resize', false], [fresh.snapshot_id]: ['manual', true] });
  });

  test('the daily job: a due backend gets an automatic snapshot kept 7 days; a fresh one does not', async () => {
    const due = await runningBackend('snap-daily', {}, { createdAt: ago(25 * 3_600_000) });
    const fresh = await runningBackend('snap-daily-fresh', {});
    const result = await sweepBackends();
    expect(result.snapshotJobs).toBeGreaterThanOrEqual(1);
    const after = await eventually(() => read(due.appId), (r) => !meta(r).operation && Boolean(meta(r).lastAutomaticSnapshotAt));
    const [id, label] = Object.entries(meta(after).snapshotLabels as Record<string, { kind: string; expiresAt: string }>)[0]!;
    expect(label.kind).toBe('automatic');
    expect(Math.abs(Date.parse(label.expiresAt) - (Date.now() + AUTOMATIC_SNAPSHOT_RETENTION_MS))).toBeLessThan(60_000);
    expect(machines.get('sbx-snap-daily')!.snapshots).toEqual([id]);
    expect(meta(after).lastOperationError).toBeUndefined();
    expect(machines.get('sbx-snap-daily-fresh')!.snapshots ?? []).toEqual([]);
    // Not due again within 24 h.
    await sweepBackends();
    expect(machines.get('sbx-snap-daily')!.snapshots).toEqual([id]);
    expect(meta(await read(fresh.appId)).lastAutomaticSnapshotAt).toBeUndefined();
    const listed = await (await route('GET', `/${due.appId}/snapshots`)).json();
    expect(listed.snapshot_schedule.last_automatic_at).toBe(meta(after).lastAutomaticSnapshotAt);
  });

  test('expiry: an expired resize snapshot goes; an expired automatic one goes only when a newer automatic exists; manual stays', async () => {
    const past = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const row = await runningBackend('snap-expire', { snapshots: ['m-1', 'r-old', 'a-old', 'a-new'] }, {
      metadata: {
        lastAutomaticSnapshotAt: new Date().toISOString(),
        snapshotLabels: {
          'r-old': { kind: 'resize', expiresAt: past(1) },
          'a-old': { kind: 'automatic', expiresAt: past(2) },
          'a-new': { kind: 'automatic', expiresAt: future(100) },
        },
      },
    });
    const lone = await runningBackend('snap-expire-lone', { snapshots: ['a-only'] }, {
      metadata: { lastAutomaticSnapshotAt: new Date().toISOString(), snapshotLabels: { 'a-only': { kind: 'automatic', expiresAt: past(5) } } },
    });
    await sweepBackends();
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation && !('r-old' in meta(r).snapshotLabels));
    expect(machines.get('sbx-snap-expire')!.snapshots).toEqual(['m-1', 'a-new']);
    expect(Object.keys(meta(after).snapshotLabels)).toEqual(['a-new']);
    // The newest automatic snapshot outlives its expiry until a newer one exists.
    expect(machines.get('sbx-snap-expire-lone')!.snapshots).toEqual(['a-only']);
    expect(meta(await read(lone.appId)).operation).toBeUndefined();
  });

  test('DELETE a snapshot: 204, gone with its label; an unknown id → 404 snapshot_not_found', async () => {
    const row = await runningBackend('snap-delete', { snapshots: ['d-1', 'd-2'] }, {
      metadata: { snapshotLabels: { 'd-2': { kind: 'automatic', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } } },
    });
    expect((await route('DELETE', `/${row.appId}/snapshots/d-2`)).status).toBe(204);
    expect(machines.get('sbx-snap-delete')!.snapshots).toEqual(['d-1']);
    expect(meta(await read(row.appId)).snapshotLabels).toEqual({});
    const missing = await route('DELETE', `/${row.appId}/snapshots/nope`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('snapshot_not_found');
    const taken = await route('POST', `/${row.appId}/snapshots`);
    expect(taken.status).toBe(201);
    expect(await taken.json()).toMatchObject({ kind: 'manual', expires_at: null });
  });

  test('an App in `recovering` can still be deleted', async () => {
    const row = await runningBackend('snap-recovering-delete', {});
    expect(await claimOperation(row.appId, 'recovering')).toBe(true);
    expect((await route('DELETE', `/${row.appId}?confirm=snap-recovering-delete`)).status).toBe(200);
    expect((await read(row.appId)).status).toBe('deleted');
  });
});

describe('snapshot labels without a snapshot', () => {
  test('a label Platinum never listed is dropped, so it never shields an expired daily snapshot', async () => {
    const past = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const row = await runningBackend('snap-phantom', { snapshots: ['a-real'] }, {
      metadata: {
        lastAutomaticSnapshotAt: past(30),
        automaticSnapshotAttemptAt: past(2),
        snapshotLabels: {
          'a-real': { kind: 'automatic', expiresAt: past(1) },
          // Labelled 2 h ago, never completed on the host.
          'a-phantom': { kind: 'automatic', expiresAt: future(7 * 24 - 2) },
        },
      },
    });
    await sweepBackends();
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation && Boolean(meta(r).lastAutomaticSnapshotAt) && Date.parse(meta(r).lastAutomaticSnapshotAt) > Date.now() - 60_000);
    const labels = meta(after).snapshotLabels as Record<string, { kind: string }>;
    expect(labels['a-phantom']).toBeUndefined();
    // The new daily snapshot is taken first, so the expired real one goes in the same job.
    expect(machines.get('sbx-snap-phantom')!.snapshots!.includes('a-real')).toBe(false);
    expect(Object.keys(labels)).toHaveLength(1);
    expect(Object.values(labels)[0]!.kind).toBe('automatic');
    expect(machines.get('sbx-snap-phantom')!.snapshots).toEqual(Object.keys(labels));
  });
});

describe('snapshot request failures (review: 20 s default timeout)', () => {
  test('a daily snapshot that takes 21 s: the POST is not aborted at the 20 s call default; the snapshot is labelled automatic', async () => {
    const row = await runningBackend('snap-slow', { snapshotDelayMs: 21_000 }, { createdAt: ago(25 * 3_600_000) });
    expect(await claimOperation(row.appId, 'snapshotting')).toBe(true);
    const result = await runSnapshotMaintenance(await read(row.appId), true);
    expect(result.taken).toBe(true);
    expect(abortedSnapshotPosts).not.toContain('sbx-snap-slow');
    const after = await read(row.appId);
    const ids = machines.get('sbx-snap-slow')!.snapshots!;
    expect(ids).toHaveLength(1);
    expect(meta(after).snapshotLabels[ids[0]!].kind).toBe('automatic');
    expect(typeof meta(after).lastAutomaticSnapshotAt).toBe('string');
    expect(meta(after).lastOperationError).toBeUndefined();
  }, 60_000);

  test('a snapshot POST that answers 504 after the host took the snapshot: the resize labels it resize and goes on', async () => {
    const row = await runningBackend('snap-504', { snapshotAnswers: 504 });
    expect(await claimOperation(row.appId, 'resizing')).toBe(true);
    await runResize(await read(row.appId), { cpu: 2, memoryGb: 2, diskGb: 10 });
    const after = await read(row.appId);
    expect([after.cpu, after.memoryGb]).toEqual([2, 2]);
    expect(meta(after).lastOperationError).toBeUndefined();
    const ids = machines.get('sbx-snap-504')!.snapshots!;
    expect(ids).toHaveLength(1);
    expect(meta(after).snapshotLabels[ids[0]!].kind).toBe('resize');
  });
});

describe('restore of a rotated backend that does not finish (review: leaked key revived)', () => {
  test('a restore that Platinum ends stopped: recovery rotates the restored secret away', async () => {
    const row = await runningBackend('restore-fail-rotated', { snapshots: ['snap-rfr'] });
    const leaked = keyFor('sbx-restore-fail-rotated');
    await rotateBackendAdminKey(row);
    Object.assign(machines.get('sbx-restore-fail-rotated')!, { backupSecret: 1, restorePolls: 1, restoreEndsIn: 'stopped' });
    const error = await restoreBackendSnapshot(await read(row.appId), 'snap-rfr').catch((e: unknown) => e);
    expect((error as BackendOperationError).code).toBe('restore_unhealthy');
    expect(machines.get('sbx-restore-fail-rotated')!.state).toBe('running');
    expect(keyFor('sbx-restore-fail-rotated')).not.toBe(leaked);
    const after = await read(row.appId);
    expect(decryptProjectSecret(PROJECT, after.adminKeyEnc!)).toBe(keyFor('sbx-restore-fail-rotated'));
    expect(meta(after).rotateAfterRestore).toBeUndefined();
  });

  test('a restore whose API process died: the takeover rotates the restored secret away', async () => {
    // The machine already runs the restored disk; its secret (1) is the key rotated away.
    const row = await runningBackend('restore-crash', {}, {
      metadata: { operation: 'restoring', operationStartedAt: ago(10 * 60_000).toISOString(), heartbeatAt: ago(5 * 60_000).toISOString(), adminKeyRotatedAt: ago(3_600_000).toISOString() },
    });
    const leaked = keyFor('sbx-restore-crash');
    await sweepBackends();
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation);
    expect(keyFor('sbx-restore-crash')).not.toBe(leaked);
    expect(decryptProjectSecret(PROJECT, after.adminKeyEnc!)).toBe(keyFor('sbx-restore-crash'));
    expect(meta(after).lastOperationError).toContain('restore was interrupted');
  });

  test('a pending rotation after a restore: the health probe rotates again', async () => {
    const row = await runningBackend('restore-pending', {}, {
      metadata: { adminKeyRotatedAt: ago(3_600_000).toISOString(), rotateAfterRestore: true },
    });
    const leaked = keyFor('sbx-restore-pending');
    await sweepBackends();
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation && !meta(r).rotateAfterRestore);
    expect(keyFor('sbx-restore-pending')).not.toBe(leaked);
    expect(decryptProjectSecret(PROJECT, after.adminKeyEnc!)).toBe(keyFor('sbx-restore-pending'));
  });
});

describe('delete: typed slug, final snapshot, retention, purge', () => {
  const del = (appId: string, confirm?: string) =>
    app.request(`/v1/projects/${PROJECT}/apps/${appId}${confirm ? `?confirm=${confirm}` : ''}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${secret}` },
    });

  test('without the typed slug → 400 confirmation_required; nothing changes', async () => {
    const row = await runningBackend('delete-unconfirmed', {});
    for (const confirm of [undefined, 'not-the-slug']) {
      const res = await del(row.appId, confirm);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('confirmation_required');
    }
    expect((await read(row.appId)).status).toBe('running');
    expect(machines.get('sbx-delete-unconfirmed')!.state).toBe('running');
  });

  test('a delete takes a final snapshot kept 7 days, stops the machine, and its hosts answer 410 until the purge', async () => {
    const row = await runningBackend('delete-retained', { snapshots: ['dk-manual'] });
    const res = await del(row.appId, 'delete-retained');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Math.abs(Date.parse(body.retained_until) - (Date.now() + 7 * 86_400_000))).toBeLessThan(60_000);
    expect(typeof body.final_snapshot_id).toBe('string');
    const after = await read(row.appId);
    expect(after.status).toBe('deleted');
    expect(after.deletedAt).not.toBeNull();
    expect(meta(after)).toMatchObject({ purgeAfter: body.retained_until, finalSnapshotId: body.final_snapshot_id });
    expect(meta(after).snapshotLabels[body.final_snapshot_id].kind).toBe('final');
    expect(machines.get('sbx-delete-retained')).toMatchObject({ state: 'stopped', autoResume: false });
    expect(machines.get('sbx-delete-retained')!.snapshots).toEqual(['dk-manual', body.final_snapshot_id]);
    // The App is gone from the API; the slug is free again.
    expect((await app.request(`/v1/projects/${PROJECT}/apps/${row.appId}`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(404);
    // The sweep neither probes nor reaps a retained machine.
    await sweepBackends();
    expect(machines.get('sbx-delete-retained')!.state).toBe('stopped');
    expect((await reapOrphanBackendMachines({ force: true })).errors).toBe(0);
    expect(machines.has('sbx-delete-retained')).toBe(true);
    // After the retention the purge deletes snapshots, machine and row.
    await db.update(appConvexInstances)
      .set({ metadata: { ...meta(after), purgeAfter: ago(1_000).toISOString() } })
      .where(eq(appConvexInstances.appId, row.appId));
    expect((await purgeRetiredConvexApps()).purged).toBeGreaterThanOrEqual(1);
    expect(machines.has('sbx-delete-retained')).toBe(false);
    expect(await readConvexRow(row.appId)).toBeUndefined();
  });

  test('while the delete runs, no snapshot can claim the App', async () => {
    const row = await runningBackend('delete-race', { snapshots: ['dr-1'], snapshotListDelayMs: 800 });
    const deleting = del(row.appId, 'delete-race');
    // Wait for the delete's mark, not a fixed delay: on a 4 vCPU CI runner the
    // route had not marked the row 300 ms in. The 800 ms snapshot list keeps
    // the delete running after the mark lands.
    await eventually(() => read(row.appId), (r) => meta(r).deleting !== undefined);
    expect(await claimOperation(row.appId, 'snapshotting')).toBe(false);
    expect((await deleting).status).toBe(200);
    expect((await read(row.appId)).status).toBe('deleted');
  });

  test('a failed delete clears the mark: the App takes operations again', async () => {
    const row = await runningBackend('delete-fails', {});
    failStop.add('sbx-delete-fails');
    const failed = await del(row.appId, 'delete-fails');
    // The route answers 502; the API edge rewrites a 502 to 503.
    expect(failed.status).toBe(503);
    expect((await failed.json()).code).toBe('app_delete_failed');
    const after = await read(row.appId);
    expect(after.status).toBe('running');
    expect(after.deletedAt).toBeNull();
    expect(meta(after).deleting).toBeUndefined();
    expect(await claimOperation(row.appId, 'snapshotting')).toBe(true);
    failStop.delete('sbx-delete-fails');
  });
});

describe('no budget: a convex App costs its size', () => {
  test('any month-to-date spend: the sweep never stops the machine and records no budget alert', async () => {
    const row = await runningBackend('budget-free', {});
    await db.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, row.appId));
    const at = new Date().toISOString();
    await db.insert(sandboxComputeSessions).values({
      accountId: row.accountId, sandboxId: row.appId, provider: 'platinum', cpuCores: 1, memoryGb: 1, diskGb: 10,
      state: 'stopped', workloadType: 'backend', costUsd: '500.000000', startedAt: at, endedAt: at, lastBilledAt: at,
    });
    const result = await sweepBackends();
    expect(result).not.toHaveProperty('budgetAlerts');
    expect(meta(await read(row.appId)).budgetAlert).toBeUndefined();
    expect(machines.get('sbx-budget-free')!.state).toBe('running');
    expect((await read(row.appId)).status).toBe('running');
    expect(calls).not.toContain('POST /v1/sandboxes/sbx-budget-free/stop');
  });
});

describe('resize snapshots are bounded (review: host disk)', () => {
  test('a second resize replaces the first resize snapshot: a backend holds at most one', async () => {
    const row = await runningBackend('resize-twice', { snapshots: ['rt-manual'] });
    expect(await claimOperation(row.appId, 'resizing')).toBe(true);
    await runResize(await read(row.appId), { cpu: 2, memoryGb: 1, diskGb: 10 });
    const [first] = Object.keys(meta(await read(row.appId)).snapshotLabels);
    expect(await claimOperation(row.appId, 'resizing')).toBe(true);
    await runResize(await read(row.appId), { cpu: 1, memoryGb: 1, diskGb: 10 });
    const labels = meta(await read(row.appId)).snapshotLabels as Record<string, { kind: string }>;
    expect(Object.values(labels).map((l) => l.kind)).toEqual(['resize']);
    expect(Object.keys(labels)[0]).not.toBe(first);
    expect(machines.get('sbx-resize-twice')!.snapshots).toEqual(['rt-manual', Object.keys(labels)[0]!]);
  });

  test("a parked backend's expired resize snapshot is deleted; the backend stays parked", async () => {
    const row = await runningBackend('parked-expiry', { state: 'stopped', autoResume: false, snapshots: ['pe-resize', 'pe-manual'] }, {
      projectId: ARCHIVED_PROJECT,
      metadata: {
        parked: ago(86_400_000).toISOString(),
        snapshotLabels: { 'pe-resize': { kind: 'resize', expiresAt: ago(3_600_000).toISOString() } },
      },
    });
    await sweepBackends();
    await eventually(() => Promise.resolve(machines.get('sbx-parked-expiry')!.snapshots!), (ids) => !ids.includes('pe-resize'));
    const after = await eventually(() => read(row.appId), (r) => !meta(r).operation);
    expect(machines.get('sbx-parked-expiry')!.snapshots).toEqual(['pe-manual']);
    expect(meta(after).snapshotLabels).toEqual({});
    expect(typeof meta(after).parked).toBe('string');
    expect(machines.get('sbx-parked-expiry')!.state).toBe('stopped');
    expect(meta(after).lastAutomaticSnapshotAt).toBeUndefined();
  });
});
