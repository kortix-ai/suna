import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  creditAccounts,
  projectBackends,
  projectMembers,
  projects,
  sandboxComputeSessions,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/surface';
import { MAX_PROVISION_ATTEMPTS, UNHEALTHY_ALERT_AFTER, sweepBackends } from './maintenance';
import { BackendOperationError, claimOperation, rotateBackendAdminKey } from './operations';
import { type BackendRow, discardMachine } from './provision';
import { ORPHAN_MACHINE_GRACE_MS, deleteAccountBackends, reapOrphanBackendMachines } from './lifecycle';
import { sandboxOwnershipMarker } from '../platform/sandbox-ownership';

// The backends maintenance sweep, admin-key rotation and the logs route
// against the real DB, a fake Platinum API and a fake Convex backend. Proves:
// an interrupted provision resumes on the same machine (H6), an interrupted
// operation is recovered (H6), the probe records health and repairs a stopped,
// lost or tombstoned machine (H1), rotation re-seals the key Convex accepts
// (H4), the logs route returns the process log without color codes (L1), an
// archived project's backends park and come back (D9), account deletion
// deletes machines and snapshots (D9), orphaned machines are deleted (B5), and
// a running backend is metered (D11).

type Machine = {
  state: string;
  recoverable?: boolean;
  cpu: number;
  ramMb: number;
  diskGb: number;
  secret: number;
  autoResume?: boolean;
  snapshots?: string[];
  /** Listed by GET /v1/sandboxes; a machine without it is not listed. */
  metadata?: Record<string, unknown>;
  createdAt?: string;
};
const machines = new Map<string, Machine>();
const calls: string[] = [];
const listPages: string[] = [];
let convexDown = false;

const keyFor = (id: string) => `synthetic|${id}-secret-${machines.get(id)?.secret ?? 0}`;
const machineOf = (path: string) => /^\/v1\/sandboxes\/([^/?]+)/.exec(path)?.[1] ?? '';
/** Machines whose DELETE answers 500. */
const failDelete = new Set<string>();

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
    if (req.method === 'GET' && sub === '/snapshots') return Response.json((m.snapshots ?? []).map((sid) => ({ id: sid, createdAt: '2026-10-07T00:00:00Z' })));
    if (req.method === 'DELETE' && sub.startsWith('/snapshots/')) {
      m.snapshots = (m.snapshots ?? []).filter((sid) => sid !== sub.slice('/snapshots/'.length));
      return Response.json({ deleted: true });
    }
    if (req.method === 'PATCH' && sub === '') {
      m.autoResume = ((await req.json()) as { auto_resume: boolean }).auto_resume;
      return Response.json(m);
    }
    if (req.method === 'POST' && sub === '/stop') {
      if (m.state !== 'running') return Response.json({ code: 'sandbox_not_running' }, { status: 409 });
      m.state = 'stopped';
      return Response.json({ state: 'stopping' });
    }
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
      if (failDelete.has(id)) return Response.json({ error: 'synthetic failure' }, { status: 500 });
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

  test("an archived project's stopped backend is not probed or started; it is parked", async () => {
    const row = await runningBackend('archived', { state: 'stopped' }, { projectId: ARCHIVED_PROJECT });
    await sweepBackends();
    const after = await read(row.backendId);
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

describe('archive and unarchive (D9)', () => {
  test('a running backend of an archived project is parked once: auto-resume off, stopped, marked', async () => {
    const row = await runningBackend('park-me', { autoResume: true }, { projectId: ARCHIVED_PROJECT });
    const result = await sweepBackends();
    expect(result.parked).toBeGreaterThanOrEqual(1);
    expect(machines.get('sbx-park-me')).toMatchObject({ state: 'stopped', autoResume: false });
    const after = await read(row.backendId);
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
      () => read(row.backendId),
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
    const after = await read(row.backendId);
    expect(after.status).toBe('deleted');
    expect(after.deletedAt).not.toBeNull();
    expect(machines.has('sbx-account-stays')).toBe(true);
    expect((await read(survivor.backendId)).deletedAt).toBeNull();
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
      expect((await read(row.backendId)).deletedAt).toBeNull();
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
    const [row] = await db
      .insert(projectBackends)
      .values({ backendId, projectId: PROJECT, accountId: ACCOUNT, name: 'pending', status: 'error', provider: 'platinum', externalId: 'sbx-pending', cpu: 1, memoryGb: 1, diskGb: 10, metadata: { lastError: 'x', machineDeletePending: true } })
      .returning();
    const result = await sweepBackends();
    expect(result.machinesDeleted).toBeGreaterThanOrEqual(1);
    expect(machines.has('sbx-pending')).toBe(false);
    expect(meta(await read(row!.backendId)).machineDeletePending).toBeUndefined();
  });

  test('every page, every state: old unreferenced machines go with their snapshots; young, referenced and foreign ones stay', async () => {
    const owner = await sandboxOwnershipMarker();
    const tag = (backendId: string, managed = owner) => ({ 'kortix.managed': managed, 'kortix.workload': 'backend', 'kortix.backend_id': backendId });
    const old = new Date(Date.now() - 2 * ORPHAN_MACHINE_GRACE_MS).toISOString();
    const base = { cpu: 1, ramMb: 1024, diskGb: 10, secret: 1 };
    // Referenced by a live running row: kept.
    const kept = await runningBackend('orphan-kept', {});
    Object.assign(machines.get('sbx-orphan-kept')!, { metadata: tag(kept.backendId), createdAt: old });
    // No row at all, stopped, with a snapshot: deleted.
    machines.set('sbx-orphan-rowless', { ...base, state: 'stopped', snapshots: ['snap-o'], metadata: tag(crypto.randomUUID()), createdAt: old });
    // No row, but younger than the grace: kept.
    machines.set('sbx-orphan-young', { ...base, state: 'running', metadata: tag(crypto.randomUUID()), createdAt: new Date().toISOString() });
    // A soft-deleted row: deleted.
    const [deleted] = await db
      .insert(projectBackends)
      .values({ projectId: PROJECT, accountId: ACCOUNT, name: 'orphan-deleted', status: 'deleted', provider: 'platinum', externalId: 'sbx-orphan-deleted', cpu: 1, memoryGb: 1, diskGb: 10, deletedAt: new Date() })
      .returning();
    machines.set('sbx-orphan-deleted', { ...base, state: 'running', metadata: tag(deleted!.backendId), createdAt: old });
    // A second machine for a running row that references another one: deleted.
    machines.set('sbx-orphan-duplicate', { ...base, state: 'running', metadata: tag(kept.backendId), createdAt: old });
    // A provisioning row owns its machine before it records the id: kept.
    const [provisioning] = await db
      .insert(projectBackends)
      .values({ projectId: PROJECT, accountId: ACCOUNT, name: 'orphan-provisioning', status: 'provisioning', provider: 'platinum', cpu: 1, memoryGb: 1, diskGb: 10, metadata: { heartbeatAt: new Date().toISOString() } })
      .returning();
    machines.set('sbx-orphan-provisioning', { ...base, state: 'running', metadata: tag(provisioning!.backendId), createdAt: old });
    // Another control plane's machine: never ours to delete.
    machines.set('sbx-orphan-foreign', { ...base, state: 'running', metadata: tag(crypto.randomUUID(), 'v2-another-database'), createdAt: old });
    listPages.length = 0;

    const result = await reapOrphanBackendMachines({ force: true });

    expect(result).toMatchObject({ deleted: 3, errors: 0 });
    expect(listPages.length).toBeGreaterThanOrEqual(4);
    for (const search of listPages) expect(search).toContain('regions=local');
    for (const gone of ['sbx-orphan-rowless', 'sbx-orphan-deleted', 'sbx-orphan-duplicate']) expect(machines.has(gone)).toBe(false);
    expect(calls).toContain('DELETE /v1/sandboxes/sbx-orphan-rowless/snapshots/snap-o');
    for (const stays of ['sbx-orphan-kept', 'sbx-orphan-young', 'sbx-orphan-provisioning', 'sbx-orphan-foreign']) {
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
      const windows = () => db.select().from(sandboxComputeSessions).where(eq(sandboxComputeSessions.sandboxId, row.backendId));
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
