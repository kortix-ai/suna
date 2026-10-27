/**
 * Integration test (real Postgres, Platinum stubbed at `fetch`): the
 * `workspace_volume` flag puts a session's /workspace on a Platinum volume and
 * makes its box disposable.
 *
 * - The flag is operator-only: a project admin's PATCH answers 403.
 * - The flag is read once, at create; the session record alone decides later.
 * - Every volume call goes to the control plane of the volume's region.
 * - A volume that does not open fails the boot with a storage message.
 * - A box stopped past the idle window is retired and removed; an open removes
 *   a retired box whose removal failed before it boots a new one.
 * - The volume outlives the trash window and goes with the purge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

const { eq, sql } = await import('drizzle-orm');
const { accountMembers, projectMembers, projectSessions, sessionSandboxes } = await import('@kortix/db');
const { config } = await import('../config');
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { insertIntoView } = await import('./helpers/compat-views');
const { seedProject, seedSession } = await import('./helpers/integration-fixtures');
const { fakeSessionStorage } = await import('./helpers/fake-session-storage');
const { createSessionAttachmentStore } = await import('../projects/lib/session-attachments');
const { purgeSessionContent } = await import('../projects/session-log-purge');
const { __resetPlatinumSandboxOriginsForTests } = await import('../shared/platinum');
const { classifySandboxProvisioningFailure } = await import('../platform/services/sandbox-provisioning-error');
const { isRetiredSandboxRow } = await import('../platform/services/retired-sandbox-row');
const { idleRetiredBoxRemoved, retireIdleVolumeBoxes } = await import('../projects/reaping/idle-volume-retire');
const { applyWorkspaceVolume, resolveWorkspaceVolume, startWorkspaceVolume } = await import(
  '../platform/services/workspace-volume'
);

type CreateSandboxOpts = import('../platform/providers/contract').CreateSandboxOpts;

const OWNER = crypto.randomUUID();
const PT = 'https://api.platinum.test';
const PT_US = 'https://us-east.api.platinum.test';
const FLAG_ON = { experimental: { workspace_volume: true } };
const HOUR = 3_600_000;

const original = {
  PLATINUM_API_URL: config.PLATINUM_API_URL,
  PLATINUM_API_KEY: config.PLATINUM_API_KEY,
  ALLOWED_SANDBOX_PROVIDERS: config.ALLOWED_SANDBOX_PROVIDERS,
  KORTIX_WORKSPACE_VOLUMES: config.KORTIX_WORKSPACE_VOLUMES,
  KORTIX_SANDBOX_IDLE_DELETE_MINUTES: config.KORTIX_SANDBOX_IDLE_DELETE_MINUTES,
};
const realFetch = globalThis.fetch;
let calls: Array<{ method: string; url: string; body: string }> = [];
let answer: (url: URL, method: string) => Response = () => Response.json({});
let project: Awaited<ReturnType<typeof seedProject>>;
const minted: string[] = [];
let ownerSecret = '';

const callLines = () => calls.map((c) => `${c.method} ${c.url}`);

/** A session row as POST /sessions inserts it: `own` carries the record of its volume. */
async function newSession(record: 'none' | 'own' | 'forged' = 'none', extra: Record<string, unknown> = {}): Promise<string> {
  const sessionId = await seedSession(project, OWNER);
  const name = record === 'own' ? `kws-${sessionId}` : 'kws-someone-else';
  const metadata = record === 'none' ? extra : { workspace_volume: { name, location: null }, ...extra };
  await db.update(projectSessions).set({ metadata }).where(eq(projectSessions.sessionId, sessionId));
  return sessionId;
}

async function stoppedBox(sessionId: string, externalId: string, metadata: Record<string, unknown>) {
  await db.insert(sessionSandboxes).values({
    sandboxId: sessionId,
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    provider: 'platinum',
    status: 'stopped',
    externalId,
    metadata,
  });
}

const boxRow = async (sessionId: string) =>
  (await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)))[0]!;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Run through pnpm test -- --db-only workspace-volume');
  config.PLATINUM_API_URL = PT;
  config.PLATINUM_API_KEY = 'pt_synthetic_workspace_volume';
  config.ALLOWED_SANDBOX_PROVIDERS = ['platinum'];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== PT && url.origin !== PT_US) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url: url.href, body: typeof init?.body === 'string' ? init.body : '' });
    return answer(url, method);
  }) as typeof fetch;

  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  project = await seedProject('workspace-volume');
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: project.account_id, accountRole: 'owner', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: OWNER, projectRole: 'manager' },
  ]);
  const owner = await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'workspace-volume-owner' });
  minted.push(owner.tokenId);
  ownerSecret = owner.secretKey;
});

beforeEach(() => {
  calls = [];
  answer = (url, method) =>
    method === 'DELETE'
      ? new Response(null, { status: 204 })
      : url.pathname.endsWith('/health')
        ? Response.json({ status: 'ok', reason: null })
        : Response.json({ region: url.origin === PT_US ? 'us-east' : 'eu-west' });
  config.KORTIX_WORKSPACE_VOLUMES = '';
  config.KORTIX_SANDBOX_IDLE_DELETE_MINUTES = 60;
  __resetPlatinumSandboxOriginsForTests();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config, original);
  // The database is this file's own (db-suites): box rows with an identity cannot be deleted.
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
});

describe('workspace_volume', () => {
  test('is operator-only: a project admin cannot turn it on', async () => {
    const res = await app.request(`/v1/projects/${project.project_id}/features`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'workspace_volume', enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('feature_operator_only');
  });

  test('create opens a us-east volume at the us-east control plane once; provisioning reuses that open', async () => {
    const sessionId = crypto.randomUUID();
    const volume = startWorkspaceVolume({ sessionId, projectMetadata: FLAG_ON, location: 'us-east' });
    expect(volume).toEqual({ name: `kws-${sessionId}`, location: 'us-east' });
    await newSessionWithId(sessionId, volume);
    expect(await resolveWorkspaceVolume(sessionId)).toEqual(volume);
    expect(calls).toEqual([{ method: 'PUT', url: `${PT_US}/v1/volumes/kws-${sessionId}`, body: '{"sync_mode":"git"}' }]);

    // A later box: the flag is off and the kill switch is on. The record decides.
    calls = [];
    config.KORTIX_WORKSPACE_VOLUMES = 'off';
    expect(await resolveWorkspaceVolume(sessionId)).toEqual(volume);
    expect(callLines()).toEqual([`PUT ${PT_US}/v1/volumes/kws-${sessionId}`]);
  });

  test('flag off, kill switch on, no record or a forged record: no volume, no Platinum call', async () => {
    const id = crypto.randomUUID();
    expect(startWorkspaceVolume({ sessionId: id, projectMetadata: {}, location: undefined })).toBeNull();
    config.KORTIX_WORKSPACE_VOLUMES = 'off';
    expect(startWorkspaceVolume({ sessionId: id, projectMetadata: FLAG_ON, location: undefined })).toBeNull();
    expect(await resolveWorkspaceVolume(await newSession('none'))).toBeNull();
    expect(await resolveWorkspaceVolume(await newSession('forged'))).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a volume that does not open fails the boot with a storage message; a 4xx is not retried', async () => {
    const sessionId = await newSession('own');
    answer = () => Response.json({ code: 'quota_exceeded', limit: 'volumes' }, { status: 403 });
    const quota = await resolveWorkspaceVolume(sessionId).catch((e) => e);
    expect(callLines()).toEqual([`PUT ${PT}/v1/volumes/kws-${sessionId}`]);
    expect(classifySandboxProvisioningFailure(quota)).toMatchObject({
      category: 'drives-unavailable',
      userMessage: expect.stringContaining('storage volume limit'),
      transient: false,
    });

    calls = [];
    answer = () => new Response('upstream', { status: 503 });
    const down = await resolveWorkspaceVolume(sessionId).catch((e) => e);
    expect(calls).toHaveLength(3);
    // Storage that did not answer is retried by the next /start.
    expect(classifySandboxProvisioningFailure(down)).toMatchObject({ category: 'drives-unavailable', transient: true });
  }, 20_000);

  test('the box create mounts the volume privately in its region, without backup or branch restore', () => {
    const create = {
      accountId: project.account_id,
      userId: OWNER,
      name: 'session-x',
      location: undefined as string | undefined,
      volumes: { '/drives/Desktop': { volume: 'drive-x', subdir: '/u' } } as CreateSandboxOpts['volumes'],
      envVars: { KORTIX_SESSION_BRANCH_RESTORE: '1', KORTIX_TOKEN: 't' } as Record<string, string>,
    };
    applyWorkspaceVolume(create, { name: 'kws-x', location: 'us-east' });
    expect(create.volumes).toEqual({
      '/drives/Desktop': { volume: 'drive-x', subdir: '/u' },
      '/workspace': { volume: 'kws-x', share: 'private' },
    });
    expect(create).toMatchObject({ location: 'us-east', locationRequired: true, volumesRequired: true });
    expect(create.envVars).toEqual({ KORTIX_TOKEN: 't', KORTIX_WORKSPACE_VOLUME: '1' });
  });

  test('the idle lane retires and removes only a volume session box stopped past the window', async () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 2 * HOUR).toISOString();
    const idle = await volumeSessionWithBox('sbx-idle', { stoppedAt: longAgo });
    const boxDisk = await newSession('none');
    await stoppedBox(boxDisk, 'sbx-box-disk', { stoppedAt: longAgo });
    const deletedSession = await newSession('own', { deletedAt: longAgo });
    await stoppedBox(deletedSession, 'sbx-deleted', { stoppedAt: longAgo });
    const recent = await volumeSessionWithBox('sbx-recent', { stoppedAt: new Date(now.getTime() - 10 * 60_000).toISOString() });
    const waking = await volumeSessionWithBox('sbx-waking', { stoppedAt: longAgo, runtimeWakeId: 'wake-1' });

    expect(await retireIdleVolumeBoxes(now)).toEqual({ retired: 1, removed: 1, failed: 0, held: 0 });
    expect(callLines()).toEqual([`GET ${PT}/v1/volumes/kws-${idle}/health?probe=false`, `DELETE ${PT}/v1/sandboxes/sbx-idle`]);
    const row = await boxRow(idle);
    expect(isRetiredSandboxRow(row)).toBe(true);
    expect(row.metadata).toMatchObject({ ephemeralRetiredExternalId: 'sbx-idle', idleRetiredAt: now.toISOString(), providerRemovedAt: now.toISOString() });
    for (const [id, ext] of [[boxDisk, 'sbx-box-disk'], [deletedSession, 'sbx-deleted'], [recent, 'sbx-recent'], [waking, 'sbx-waking']] as const) {
      expect((await boxRow(id)).externalId).toBe(ext);
    }

    // -1 turns the lane off.
    config.KORTIX_SANDBOX_IDLE_DELETE_MINUTES = -1;
    expect(await retireIdleVolumeBoxes(new Date(now.getTime() + 24 * HOUR))).toEqual({ retired: 0, removed: 0, failed: 0, held: 0 });
  });

  test('the idle lane keeps a box whose volume is not ok, and asks again an hour later', async () => {
    config.KORTIX_SANDBOX_IDLE_DELETE_MINUTES = 60;
    const now = new Date();
    const longAgo = new Date(now.getTime() - 2 * HOUR).toISOString();
    const unsaved = await volumeSessionWithBox('sbx-unsaved', { stoppedAt: longAgo });
    const unreachable = await volumeSessionWithBox('sbx-unreachable', { stoppedAt: longAgo });
    const forged = await newSession('forged');
    await stoppedBox(forged, 'sbx-forged', { stoppedAt: longAgo });
    answer = (url) =>
      url.pathname === `/v1/volumes/kws-${unsaved}/health`
        ? Response.json({ status: 'degraded', reason: 'mount vm_1 (/workspace on sbx-unsaved) has committed changes that are not on the head yet' })
        : Response.json({ error: 'volume not found', code: 'volume_not_found' }, { status: 404 });

    expect(await retireIdleVolumeBoxes(now)).toEqual({ retired: 0, removed: 0, failed: 0, held: 3 });
    // A forged record never reaches Platinum; no box is removed.
    expect(callLines().sort()).toEqual([
      `GET ${PT}/v1/volumes/kws-${unreachable}/health?probe=false`,
      `GET ${PT}/v1/volumes/kws-${unsaved}/health?probe=false`,
    ]);
    for (const [id, ext] of [[unsaved, 'sbx-unsaved'], [unreachable, 'sbx-unreachable'], [forged, 'sbx-forged']] as const) {
      const row = await boxRow(id);
      expect(row.externalId).toBe(ext);
      expect(row.metadata).toMatchObject({ idleDeleteHeldAt: now.toISOString() });
    }
    expect((await boxRow(unsaved)).metadata).toMatchObject({ idleDeleteHeldReason: expect.stringContaining('is degraded: mount vm_1') });
    expect((await boxRow(unreachable)).metadata).toMatchObject({ idleDeleteHeldReason: expect.stringContaining('health check failed') });

    // Within the hour no held box is asked about again.
    calls = [];
    expect(await retireIdleVolumeBoxes(new Date(now.getTime() + 30 * 60_000))).toEqual({ retired: 0, removed: 0, failed: 0, held: 0 });
    expect(calls).toEqual([]);

    // An hour later the saved volume lets its box go.
    answer = (url, method) =>
      method === 'DELETE' ? new Response(null, { status: 204 }) : url.pathname === `/v1/volumes/kws-${unsaved}/health`
        ? Response.json({ status: 'ok', reason: null })
        : Response.json({ status: 'stuck', reason: 'a merge job is stalled' });
    const later = new Date(now.getTime() + 61 * 60_000);
    // (Rows of earlier tests in this database may be idle by then too; they are held, never retired.)
    expect(await retireIdleVolumeBoxes(later)).toMatchObject({ retired: 1, removed: 1, failed: 0 });
    expect(isRetiredSandboxRow(await boxRow(unsaved))).toBe(true);
    expect((await boxRow(unreachable)).externalId).toBe('sbx-unreachable');
    expect((await boxRow(forged)).externalId).toBe('sbx-forged');
  });

  test('an open removes a retired box whose removal failed before it boots a new one', async () => {
    const now = new Date();
    const sessionId = await volumeSessionWithBox('sbx-stuck', { stoppedAt: new Date(now.getTime() - 2 * HOUR).toISOString() });
    answer = (url) => (url.pathname.endsWith('/health') ? Response.json({ status: 'ok' }) : new Response('upstream', { status: 503 }));
    expect(await retireIdleVolumeBoxes(now)).toEqual({ retired: 1, removed: 0, failed: 1, held: 0 });
    const retired = await boxRow(sessionId);
    expect(isRetiredSandboxRow(retired)).toBe(true);
    expect(await idleRetiredBoxRemoved(retired)).toBe(false);

    calls = [];
    answer = () => new Response(null, { status: 204 });
    expect(await idleRetiredBoxRemoved(retired)).toBe(true);
    expect(callLines()).toEqual([`DELETE ${PT}/v1/sandboxes/sbx-stuck`]);
    expect((await boxRow(sessionId)).metadata).toHaveProperty('providerRemovedAt');
    // A retired row that is not an idle retire never waits on a removal.
    expect(await idleRetiredBoxRemoved({ sandboxId: sessionId, metadata: { ephemeralRetiredExternalId: 'x' } })).toBe(true);
  });

  test('a deleted session keeps its volume through the trash window; the purge deletes it at its region', async () => {
    const now = new Date();
    const store = createSessionAttachmentStore(fakeSessionStorage().storage as never);
    const inTrash = await newSession();
    const expired = await newSession();
    const deleted = (id: string, daysAgo: number) =>
      db
        .update(projectSessions)
        .set({
          metadata: {
            workspace_volume: { name: `kws-${id}`, location: 'us-east' },
            deletedAt: new Date(now.getTime() - daysAgo * 24 * HOUR).toISOString(),
          },
        })
        .where(eq(projectSessions.sessionId, id));
    await deleted(inTrash, 1);
    await deleted(expired, 31);

    await purgeSessionContent({ now, store });
    expect(callLines()).toEqual([`DELETE ${PT_US}/v1/volumes/kws-${expired}?missing_ok=true`]);
    const shell = (await db.select().from(projectSessions).where(eq(projectSessions.sessionId, expired)))[0]!;
    expect(shell.metadata).toMatchObject({ workspace_volume: { name: `kws-${expired}` } });
  });
});

async function newSessionWithId(sessionId: string, volume: unknown) {
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy: OWNER,
    metadata: { workspace_volume: volume },
  });
}

async function volumeSessionWithBox(externalId: string, metadata: Record<string, unknown>): Promise<string> {
  const sessionId = await newSession('own');
  await stoppedBox(sessionId, externalId, metadata);
  return sessionId;
}
