import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectBackends, projectMembers, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/surface';
import { MAX_PROVISION_ATTEMPTS, UNHEALTHY_ALERT_AFTER, sweepBackends } from './maintenance';
import { BackendOperationError, claimOperation, rotateBackendAdminKey } from './operations';
import type { BackendRow } from './provision';

// The backends maintenance sweep, admin-key rotation and the logs route
// against the real DB, a fake Platinum API and a fake Convex backend. Proves:
// an interrupted provision resumes on the same machine (H6), an interrupted
// operation is recovered (H6), the probe records health and repairs a stopped,
// lost or tombstoned machine (H1), rotation re-seals the key Convex accepts
// (H4), and the logs route returns the process log without color codes (L1).

type Machine = { state: string; recoverable?: boolean; cpu: number; ramMb: number; diskGb: number; secret: number };
const machines = new Map<string, Machine>();
const calls: string[] = [];
let convexDown = false;

const keyFor = (id: string) => `synthetic|${id}-secret-${machines.get(id)?.secret ?? 0}`;
const machineOf = (path: string) => /^\/v1\/sandboxes\/([^/?]+)/.exec(path)?.[1] ?? '';

// One fake Convex per machine is overkill: every machine's URL is this one,
// tagged with the machine id in the path prefix.
const convex = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const [, id, ...rest] = url.pathname.split('/');
    const path = `/${rest.join('/')}`;
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
    if (req.method === 'POST' && url.pathname === '/v1/sandboxes') {
      const body = (await req.json()) as { name: string };
      const newId = `sbx-${body.name}`;
      if (!machines.has(newId)) machines.set(newId, { state: 'running', cpu: 1, ramMb: 1024, diskGb: 10, secret: 1 });
      return Response.json({
        id: newId,
        state: 'running',
        exposed: [3210, 3211, 6791].map((port) => ({ port, url: convexUrl(newId), public: true })),
      });
    }
    const m = machines.get(id);
    if (!m) return Response.json({ error: 'sandbox not found', code: 'sandbox_not_found' }, { status: 404 });
    if (req.method === 'GET' && sub === '') {
      if (m.state === 'deleted' && !m.recoverable) return Response.json({ code: 'sandbox_not_found' }, { status: 404 });
      return Response.json({ ...m, ...(m.recoverable ? { recoverable: true } : {}) });
    }
    if (req.method === 'GET' && sub === '/usage') return Response.json({ disk_used_pct: 42 });
    if (req.method === 'PUT' && sub.startsWith('/files')) return Response.json({ ok: true });
    if (req.method === 'POST' && sub === '/start') {
      m.state = 'running';
      return Response.json({ state: 'running' });
    }
    if (req.method === 'POST' && sub === '/restore-from-backup') {
      m.state = 'running';
      m.recoverable = false;
      return Response.json({ state: 'restoring' });
    }
    if (req.method === 'DELETE' && sub === '') {
      machines.delete(id);
      return Response.json({ ok: true });
    }
    if (req.method === 'POST' && sub === '/exec') {
      const script = ((await req.json()) as { cmd: string[] }).cmd[2]!;
      if (script.includes('generate_admin_key.sh')) return Response.json({ result: { exit_code: 0, stdout: `Admin key:\n${keyFor(id)}\n` } });
      if (script.includes('instance_secret.next')) {
        m.secret += 1;
        return Response.json({ result: { exit_code: 0, stdout: '' } });
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
    { projectId: PROJECT, accountId: ACCOUNT, name: 'backend-maintenance', repoUrl: 'https://example.com/bm.git', metadata: { experimental: { backends: true } } },
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
  await db.delete(projectBackends).where(eq(projectBackends.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  platinum.stop(true);
  convex.stop(true);
});

const ago = (ms: number) => new Date(Date.now() - ms);

/** A running backend on machine `sbx-<name>`, holding that machine's current admin key. */
async function runningBackend(name: string, machine: Partial<Machine>, extra: Partial<BackendRow> = {}): Promise<BackendRow> {
  const externalId = `sbx-${name}`;
  machines.set(externalId, { state: 'running', cpu: 1, ramMb: 1024, diskGb: 10, secret: 1, ...machine });
  const [row] = await db
    .insert(projectBackends)
    .values({
      projectId: PROJECT,
      accountId: ACCOUNT,
      name,
      status: 'running',
      provider: 'platinum',
      externalId,
      url: convexUrl(externalId),
      siteUrl: convexUrl(externalId),
      adminKeyEnc: encryptProjectSecret(extra.projectId ?? PROJECT, keyFor(externalId)),
      cpu: 1,
      memoryGb: 1,
      diskGb: 10,
      ...extra,
    })
    .returning();
  return row!;
}

const read = async (backendId: string) =>
  (await db.select().from(projectBackends).where(eq(projectBackends.backendId, backendId)))[0]!;
const meta = (row: BackendRow) => row.metadata as Record<string, any>;

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
    const [row] = await db
      .insert(projectBackends)
      .values({ projectId: PROJECT, accountId: ACCOUNT, name: 'resumed', status: 'provisioning', provider: 'platinum', cpu: 1, memoryGb: 1, diskGb: 10, createdAt: ago(5 * 60_000) })
      .returning();
    const fresh = (
      await db
        .insert(projectBackends)
        .values({ projectId: PROJECT, accountId: ACCOUNT, name: 'still-building', status: 'provisioning', provider: 'platinum', cpu: 1, memoryGb: 1, diskGb: 10, createdAt: ago(20 * 60_000), metadata: { heartbeatAt: ago(10_000).toISOString() } })
        .returning()
    )[0]!;
    const result = await sweepBackends();
    expect(result.resumed).toBe(1);
    const done = await eventually(() => read(row!.backendId), (r) => r.status === 'running');
    expect(done.externalId).toBe(`sbx-backend-${row!.backendId}`);
    expect(decryptProjectSecret(PROJECT, done.adminKeyEnc!)).toBe(keyFor(done.externalId!));
    expect(meta(done).provisionAttempts).toBe(2);
    expect(calls).toContain(`POST /v1/sandboxes key=kortix-backend-${row!.backendId}`);
    // A provision that heartbeats is left alone, however old the row.
    expect((await read(fresh.backendId)).status).toBe('provisioning');
    expect(meta(await read(fresh.backendId)).provisionAttempts).toBeUndefined();
  });

  test(`a provision interrupted ${MAX_PROVISION_ATTEMPTS} times turns error and its machine is deleted`, async () => {
    machines.set('sbx-abandoned', { state: 'running', cpu: 1, ramMb: 1024, diskGb: 10, secret: 1 });
    const [row] = await db
      .insert(projectBackends)
      .values({ projectId: PROJECT, accountId: ACCOUNT, name: 'abandoned', status: 'provisioning', provider: 'platinum', externalId: 'sbx-abandoned', cpu: 1, memoryGb: 1, diskGb: 10, createdAt: ago(60 * 60_000), metadata: { provisionAttempts: MAX_PROVISION_ATTEMPTS, heartbeatAt: ago(5 * 60_000).toISOString() } })
      .returning();
    const result = await sweepBackends();
    expect(result.failedProvisions).toBe(1);
    const after = await read(row!.backendId);
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
    const after = await eventually(() => read(row.backendId), (r) => !meta(r).operation);
    expect(machines.get('sbx-resize-died')!.state).toBe('running');
    expect([after.cpu, after.memoryGb, after.diskGb]).toEqual([2, 4, 20]);
    expect(meta(after).lastOperationError).toBe('The resize was interrupted. The backend runs again; retry it.');
    expect(meta(after).heartbeatAt).toBeUndefined();
  });

  test('a resize that still heartbeats is not touched', async () => {
    const row = await runningBackend('resize-alive', { state: 'stopped' }, {
      metadata: { operation: 'resizing', operationStartedAt: ago(10 * 60_000).toISOString(), heartbeatAt: ago(5_000).toISOString() },
    });
    await sweepBackends();
    expect(meta(await read(row.backendId)).operation).toBe('resizing');
    expect(machines.get('sbx-resize-alive')!.state).toBe('stopped');
  });
});

describe('health probe (H1)', () => {
  test('a healthy backend records ok, the machine state and disk use', async () => {
    const row = await runningBackend('healthy', {});
    await sweepBackends();
    const health = meta(await read(row.backendId)).health;
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
    const after = await read(row.backendId);
    expect(after.status).toBe('running');
    expect(meta(after).health).toMatchObject({ ok: false, machine_state: 'running', failures: 2, error: 'Convex answered HTTP 503' });
    await sweepBackends();
    expect(meta(await read(row.backendId)).health).toMatchObject({ ok: true, failures: 0 });
  });

  test('a stopped machine is started and the admin key re-sealed', async () => {
    const row = await runningBackend('stopped', { state: 'stopped' });
    const result = await sweepBackends();
    expect(result.repairs).toBeGreaterThanOrEqual(1);
    expect(meta(await read(row.backendId)).health).toMatchObject({ ok: false, machine_state: 'stopped', repair: 'started' });
    const after = await eventually(() => read(row.backendId), (r) => !meta(r).operation);
    expect(machines.get('sbx-stopped')!.state).toBe('running');
    expect(meta(after).lastOperationError).toBeUndefined();
    await sweepBackends();
    expect(meta(await read(row.backendId)).health).toMatchObject({ ok: true, machine_state: 'running' });
  });

  test('a system-tombstoned machine with a backup is restored from it; the restored secret is the one Kortix seals', async () => {
    const row = await runningBackend('tombstoned', { state: 'deleted', recoverable: true });
    // The backup predates a rotation: the machine comes back on an older secret.
    machines.get('sbx-tombstoned')!.secret = 7;
    await sweepBackends();
    expect(meta(await read(row.backendId)).health).toMatchObject({ machine_state: 'tombstoned', repair: 'restored_from_backup' });
    const after = await eventually(() => read(row.backendId), (r) => !meta(r).operation);
    expect(calls).toContain('POST /v1/sandboxes/sbx-tombstoned/restore-from-backup');
    expect(decryptProjectSecret(PROJECT, after.adminKeyEnc!)).toBe('synthetic|sbx-tombstoned-secret-7');
  });

  test(`a machine Platinum no longer has turns the row error after ${UNHEALTHY_ALERT_AFTER} probes`, async () => {
    const row = await runningBackend('gone', {});
    machines.delete('sbx-gone');
    for (let i = 1; i < UNHEALTHY_ALERT_AFTER; i += 1) {
      await sweepBackends();
      expect((await read(row.backendId)).status).toBe('running');
    }
    await sweepBackends();
    const after = await read(row.backendId);
    expect(after.status).toBe('error');
    expect(meta(after).health).toMatchObject({ ok: false, machine_state: 'missing', failures: UNHEALTHY_ALERT_AFTER });
    expect(meta(after).lastError).toContain('no longer exists');
  });

  test("an archived project's stopped backend is not probed or started", async () => {
    const row = await runningBackend('archived', { state: 'stopped' }, { projectId: ARCHIVED_PROJECT });
    await sweepBackends();
    expect(meta(await read(row.backendId)).health).toBeUndefined();
    expect(machines.get('sbx-archived')!.state).toBe('stopped');
  });
});

describe('admin-key rotation (H4)', () => {
  test('rotation changes the secret, seals the key Convex now accepts, and clears the marker', async () => {
    const row = await runningBackend('rotate', {});
    const before = keyFor('sbx-rotate');
    await rotateBackendAdminKey(row);
    const after = await read(row.backendId);
    const sealed = decryptProjectSecret(PROJECT, after.adminKeyEnc!);
    expect(sealed).not.toBe(before);
    expect(sealed).toBe(keyFor('sbx-rotate'));
    expect(meta(after).operation).toBeUndefined();
    expect(meta(after).lastOperationError).toBeUndefined();
  });

  test('a rotation during another operation answers backend_busy and changes nothing', async () => {
    const row = await runningBackend('rotate-busy', {});
    expect(await claimOperation(row.backendId, 'resizing')).toBe(true);
    const error = await rotateBackendAdminKey(row).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendOperationError);
    expect((error as BackendOperationError).code).toBe('backend_busy');
    expect(machines.get('sbx-rotate-busy')!.secret).toBe(1);
  });
});

describe('routes', () => {
  const call = (method: string, path: string) =>
    app.request(`/v1/projects/${PROJECT}/backends${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });

  test('POST /rotate-admin-key: the old key stops matching, credentials return the new one', async () => {
    const row = await runningBackend('route-rotate', {});
    const before = (await (await call('GET', `/${row.backendId}/credentials`)).json()).admin_key;
    const res = await call('POST', `/${row.backendId}/rotate-admin-key`);
    expect(res.status).toBe(200);
    expect((await res.json()).backend.operation).toBeNull();
    const now = (await (await call('GET', `/${row.backendId}/credentials`)).json()).admin_key;
    expect(now).not.toBe(before);
    expect(now).toBe(keyFor('sbx-route-rotate'));
  });

  test('GET /logs: the tail without color codes, no-store; lines out of range → 400', async () => {
    const row = await runningBackend('route-logs', {});
    const res = await call('GET', `/${row.backendId}/logs?lines=50`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).log).toBe(' INFO started (50 lines)\nconvex exited 1 at 1700000000\n');
    expect((await call('GET', `/${row.backendId}/logs?lines=0`)).status).toBe(400);
    expect((await call('GET', `/${row.backendId}/logs?lines=1001`)).status).toBe(400);
  });

  test('GET a backend carries its last health probe', async () => {
    const row = await runningBackend('route-health', {});
    expect((await (await call('GET', `/${row.backendId}`)).json()).backend.health).toBeNull();
    await sweepBackends();
    const { backend } = await (await call('GET', `/${row.backendId}`)).json();
    expect(backend.health).toMatchObject({ ok: true, machine_state: 'running', disk_used_pct: 42 });
  });
});
