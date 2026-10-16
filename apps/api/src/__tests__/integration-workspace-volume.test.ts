/**
 * Integration test (real Postgres, Platinum stubbed at `fetch`): the
 * `workspace_volume` flag puts a session's /workspace on a Platinum volume.
 *
 * - The flag is operator-only: a project admin's PATCH answers 403.
 * - The first box records the volume and its region once; every later box of
 *   the session gets the same volume in the same region, whatever the flag,
 *   the kill switch or the project's region say then.
 * - Every volume call goes to the control plane of the volume's region.
 * - A volume that does not open fails the boot with a storage message.
 * - A deleted session's volume is deleted after its box, by the removal lane;
 *   a session that is not deleted keeps it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

const { eq, sql } = await import('drizzle-orm');
const { accountMembers, accounts, projectMembers, projectSessions, projects, sessionSandboxes } = await import('@kortix/db');
const { config } = await import('../config');
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { insertIntoView } = await import('./helpers/compat-views');
const { __resetPlatinumSandboxOriginsForTests } = await import('../shared/platinum');
const { classifySandboxProvisioningFailure } = await import('../platform/services/sandbox-provisioning-error');
const { PROVIDER_REMOVAL_PENDING_KEY, PROVIDER_REMOVED_KEY, removeArchivedProviderBoxes } = await import(
  '../projects/reaping/archived-box-removal'
);
const { applyWorkspaceVolume, resolveWorkspaceVolume, workspaceVolumeName } = await import(
  '../platform/services/workspace-volume'
);

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const PT = 'https://api.platinum.test';
const PT_US = 'https://us-east.api.platinum.test';
const FLAG_ON = { experimental: { workspace_volume: true } };

const original = {
  PLATINUM_API_URL: config.PLATINUM_API_URL,
  PLATINUM_API_KEY: config.PLATINUM_API_KEY,
  ALLOWED_SANDBOX_PROVIDERS: config.ALLOWED_SANDBOX_PROVIDERS,
  KORTIX_WORKSPACE_VOLUMES: config.KORTIX_WORKSPACE_VOLUMES,
};
const realFetch = globalThis.fetch;
let calls: Array<{ method: string; url: string; body: string }> = [];
let answer: (url: URL, method: string) => Response = () => Response.json({ region: 'eu-west' });
const minted: string[] = [];
let ownerSecret = '';

async function newSession(metadata: Record<string, unknown> = {}): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `kortix/${sessionId}`,
    createdBy: OWNER,
    status: 'running',
    metadata,
  });
  return sessionId;
}

async function sessionMetadata(sessionId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId));
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

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
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'workspace-volume-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'workspace-volume-test', repoUrl: 'https://example.com/wv.git' });
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'manager' }]);
  const owner = await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'workspace-volume-owner' });
  minted.push(owner.tokenId);
  ownerSecret = owner.secretKey;
});

beforeEach(() => {
  calls = [];
  answer = (url) => Response.json({ region: url.origin === PT_US ? 'us-east' : 'eu-west' });
  config.KORTIX_WORKSPACE_VOLUMES = '';
  __resetPlatinumSandboxOriginsForTests();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config, original);
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, ACCOUNT));
  await db.delete(projectSessions).where(eq(projectSessions.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

/** A session with a us-east volume whose box row is archived and stamped for removal, with no box. */
async function archivedVolumeSession(extra: Record<string, unknown>) {
  const sessionId = await newSession();
  const metadata = { ...extra, workspace_volume: { name: `kws-${sessionId}`, location: 'us-east' } };
  await db.update(projectSessions).set({ metadata }).where(eq(projectSessions.sessionId, sessionId));
  await db.insert(sessionSandboxes).values({
    sandboxId: sessionId,
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    provider: 'platinum',
    status: 'archived',
    externalId: null,
    metadata: { [PROVIDER_REMOVAL_PENDING_KEY]: new Date().toISOString() },
  });
  const row = async () =>
    ((await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)))[0]!.metadata ?? {}) as Record<string, unknown>;
  return { sessionId, row };
}

describe('workspace_volume', () => {
  test('is operator-only: a project admin cannot turn it on', async () => {
    const res = await app.request(`/v1/projects/${PROJECT}/features`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'workspace_volume', enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('feature_operator_only');
  });

  test('a us-east session records its volume once and opens it at the us-east control plane only', async () => {
    const sessionId = await newSession();
    const first = await resolveWorkspaceVolume({ sessionId, projectMetadata: FLAG_ON, location: 'us-east' });
    expect(first).toEqual({ name: `kws-${sessionId}`, location: 'us-east' });
    expect((await sessionMetadata(sessionId)).workspace_volume).toEqual(first);
    expect(calls).toEqual([{ method: 'PUT', url: `${PT_US}/v1/volumes/kws-${sessionId}`, body: '{"sync_mode":"git"}' }]);

    // A later box: the project moved home and the flag is off. The session keeps its volume and region.
    calls = [];
    const later = await resolveWorkspaceVolume({ sessionId, projectMetadata: {}, location: undefined });
    expect(later).toEqual(first);
    expect(calls.map((c) => c.url)).toEqual([`${PT_US}/v1/volumes/kws-${sessionId}`]);
  });

  test('a home-region session opens its volume at the global origin and records no region', async () => {
    const sessionId = await newSession();
    expect(await resolveWorkspaceVolume({ sessionId, projectMetadata: FLAG_ON, location: undefined })).toEqual({
      name: workspaceVolumeName(sessionId),
      location: null,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`PUT ${PT}/v1/volumes/kws-${sessionId}`]);
  });

  test('flag off, kill switch on, or a forged record: no volume, no Platinum call', async () => {
    const plain = await newSession();
    expect(await resolveWorkspaceVolume({ sessionId: plain, projectMetadata: {}, location: undefined })).toBeNull();

    config.KORTIX_WORKSPACE_VOLUMES = 'off';
    const killed = await newSession();
    expect(await resolveWorkspaceVolume({ sessionId: killed, projectMetadata: FLAG_ON, location: undefined })).toBeNull();
    expect((await sessionMetadata(killed)).workspace_volume).toBeUndefined();

    const forged = await newSession({ workspace_volume: { name: 'kws-someone-else', location: null } });
    expect(await resolveWorkspaceVolume({ sessionId: forged, projectMetadata: {}, location: undefined })).toBeNull();
    expect(calls).toEqual([]);
  });

  test('the kill switch never takes a volume away from a session that has one', async () => {
    const sessionId = await newSession();
    await resolveWorkspaceVolume({ sessionId, projectMetadata: FLAG_ON, location: undefined });
    config.KORTIX_WORKSPACE_VOLUMES = 'off';
    expect(await resolveWorkspaceVolume({ sessionId, projectMetadata: FLAG_ON, location: undefined })).toEqual({
      name: `kws-${sessionId}`,
      location: null,
    });
  });

  test('a volume that does not open fails the boot with a storage message; a 4xx is not retried', async () => {
    const sessionId = await newSession();
    answer = () => Response.json({ code: 'quota_exceeded', limit: 'volumes' }, { status: 403 });
    const quota = await resolveWorkspaceVolume({ sessionId, projectMetadata: FLAG_ON, location: undefined }).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(classifySandboxProvisioningFailure(quota)).toMatchObject({
      category: 'drives-unavailable',
      userMessage: expect.stringContaining('storage volume limit'),
    });

    calls = [];
    answer = () => new Response('upstream', { status: 503 });
    const down = await resolveWorkspaceVolume({ sessionId, projectMetadata: FLAG_ON, location: undefined }).catch((e) => e);
    expect(calls).toHaveLength(3);
    expect(String(down.message)).toStartWith('[workspace] ');
  }, 20_000);

  test('the box create mounts the volume in its region and drops the one-time branch restore', () => {
    const create = {
      accountId: ACCOUNT,
      userId: OWNER,
      name: 'session-x',
      location: undefined as string | undefined,
      volumes: { '/drives/Desktop': { volume: 'drive-x', subdir: '/u' } } as Record<string, { volume: string; subdir?: string }>,
      envVars: { KORTIX_SESSION_BRANCH_RESTORE: '1', KORTIX_TOKEN: 't' } as Record<string, string>,
    };
    applyWorkspaceVolume(create, { name: 'kws-x', location: 'us-east' });
    expect(create.volumes).toEqual({ '/drives/Desktop': { volume: 'drive-x', subdir: '/u' }, '/workspace': { volume: 'kws-x' } });
    expect(create).toMatchObject({ location: 'us-east', locationRequired: true });
    expect(create.envVars).toEqual({ KORTIX_TOKEN: 't', KORTIX_WORKSPACE_VOLUME: '1' });
  });

  test('a session that is not deleted keeps its volume when its box is removed (lost-session recovery)', async () => {
    const { sessionId, row } = await archivedVolumeSession({});
    await removeArchivedProviderBoxes();
    expect(calls.filter((c) => c.url.includes(sessionId))).toEqual([]);
    expect(await row()).toHaveProperty(PROVIDER_REMOVED_KEY);
  });

  test('the removal lane deletes a deleted session’s volume after its box, at its region; volume_busy retries', async () => {
    const { sessionId, row } = await archivedVolumeSession({ deletedAt: new Date().toISOString() });

    answer = () => Response.json({ code: 'volume_busy', mounts: [{ sandbox_id: 'sbx_x' }] }, { status: 409 });
    await removeArchivedProviderBoxes();
    // volume_busy is waited out for ~10 s (5 tries), then the lane backs off.
    expect(calls.filter((c) => c.url.includes(sessionId)).map((c) => `${c.method} ${c.url}`)).toEqual(
      Array(5).fill(`DELETE ${PT_US}/v1/volumes/kws-${sessionId}?missing_ok=true`),
    );
    expect(await row()).toMatchObject({ providerRemovalAttempts: 1, providerRemovalError: expect.stringContaining('409') });
    expect(await row()).not.toHaveProperty(PROVIDER_REMOVED_KEY);

    calls = [];
    answer = () => new Response(null, { status: 204 });
    await db.execute(sql`update kortix.session_sandboxes set metadata = metadata - 'providerRemovalRetryAfterAt' where sandbox_id = ${sessionId}`);
    await removeArchivedProviderBoxes();
    expect(calls.filter((c) => c.url.includes(sessionId))).toHaveLength(1);
    expect(await row()).toHaveProperty(PROVIDER_REMOVED_KEY);
    expect(await row()).not.toHaveProperty(PROVIDER_REMOVAL_PENDING_KEY);
  }, 30_000);
});
