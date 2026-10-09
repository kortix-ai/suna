/**
 * Integration test (real local DB, real routes): narrowing folder access must
 * actually narrow what a session's sandbox can do, and say so when it has not.
 *
 *   - A revocation whose live detach fails is not reported done: the route
 *     answers 202 with the sessions still pending, the sandbox is recorded,
 *     and the drive worker retries the detach until it lands, without waiting
 *     for the session's next resume.
 *   - While that revocation is pending, the drive-sync routes refuse what the
 *     session no longer may use, whatever its sandbox recorded.
 *   - A block upload commits only while every path its plan writes is still
 *     writable; a commit cannot name a path the plan did not write.
 *   - A resumed sandbox whose guest still holds a mount Platinum no longer
 *     tracks gets its folders anyway: the stale mount is cleared, not kept.
 *
 * Storage and the provider are faked at the volumes module (the only module
 * that talks to them); routes, authorization, grants and the DB are real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  driveMountRevocations,
  projectSessions,
  projects,
  serviceAccounts,
  sessionSandboxes,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import * as realVolumes from '../drives/volumes';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

let detachFails = false;
const calls: string[] = [];
/** Paths the guest still has mounted though Platinum tracks no mount there. */
const staleGuest = new Set<string>();

mock.module('../drives/volumes', () => ({
  ...realVolumes,
  driveStorageAvailable: () => true,
  openDriveVolume: async (name: string) => ({ name, id: 'vol', head_commit_id: null }),
  getDriveVolume: async (name: string) => ({ name, id: 'vol', head_commit_id: 'c0' }),
  sandboxMountLimit: async () => 8,
  sandboxMountPaths: async () => [],
  sandboxVolumeMounts: async () => [],
  attachSandboxVolume: async (_box: string, mountPath: string) => {
    if (staleGuest.has(mountPath)) throw new realVolumes.DriveStorageError(409, 'Another drive is already mounted at that path', 'path_exists');
    calls.push(`attach ${mountPath}`);
  },
  unmountInGuest: async (_box: string, mountPath: string) => {
    calls.push(`unmount ${mountPath}`);
    staleGuest.delete(mountPath);
  },
  detachSandboxVolume: async (_box: string, mountPath: string) => {
    calls.push(`detach ${mountPath}`);
    if (detachFails) throw new Error('provider did not answer');
  },
  execInSandbox: async () => {},
  writeVolumeFile: async (_v: string, path: string, body: Uint8Array) => ({ path, size: body.byteLength }),
  listVolumeFilesPage: async () => ({ entries: [], next_cursor: null }),
  statVolumeFile: async (_v: string, path: string) => ({ path, type: 'file', size: 1, mtime: 1 }),
  planVolumeUpload: async () => ({ upload_id: 'up-1', missing: ['a'.repeat(64)] }),
  putVolumeUploadBlock: async () => {
    calls.push('block');
  },
  commitVolumeUpload: async () => {
    calls.push('commit');
    return { commit_id: 'c1' };
  },
}));

(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { ensureProjectDrive, setFolderGrant, listFolderGrants, reconcileSessionDrives } = await import('../drives/service');
const { retryPendingRevocations } = await import('../workers/drive-worker');
const { clearAuthorizeCaches } = await import('../iam/authorize');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const RESEARCHER = crypto.randomUUID();
const NATIVE = crypto.randomUUID(); // a running box with native mounts
const SYNCED = crypto.randomUUID(); // a box off the volume provider, synced over the API
const FENCED = crypto.randomUUID(); // a synced box whose revocation is still pending
const RESUMED = crypto.randomUUID(); // a box resumed from memory with its old mounts still in the guest

let ownerToken = '';
const sessionTokens: Record<string, string> = {};
let driveId = '';
let researchGrant = '';

const mount = (subdir: string, readOnly = false) => ({
  driveId,
  kind: 'project' as const,
  mountPath: `/drives/${subdir.split('/').filter(Boolean).pop()!.toLowerCase()}`,
  readOnly,
  subdir,
  role: 'drive' as const,
});

async function box(sessionId: string, opts: { provider: 'platinum' | 'daytona'; externalId: string; mounts: unknown[] }) {
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: OWNER,
    visibility: 'project',
    origin: 'trigger',
    agentName: 'researcher',
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: sessionId,
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    provider: opts.provider,
    externalId: opts.externalId,
    status: 'active',
    config: {},
    metadata: { driveMounts: opts.mounts, ...(opts.provider === 'platinum' ? {} : { driveSync: true }) },
  });
  const minted = await createAccountToken({
    accountId: ACCOUNT,
    userId: OWNER,
    projectId: PROJECT,
    sessionId,
    name: `drive-enforcement-${sessionId.slice(0, 8)}`,
  });
  sessionTokens[sessionId] = minted.secretKey;
}

const asOwner = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${ownerToken}` } });
const asBox = (sessionId: string, route: string, init: RequestInit = {}) =>
  app.request(`/v1/projects/${PROJECT}/sessions/${sessionId}/drive-sync/${driveId}${route}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${sessionTokens[sessionId]}` },
  });

async function recordedMounts(sandboxId: string) {
  const [row] = await db.select({ metadata: sessionSandboxes.metadata }).from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId));
  return ((row?.metadata as { driveMounts?: Array<{ subdir: string; readOnly: boolean }> }).driveMounts ?? []).map((m) => [m.subdir, m.readOnly]);
}

async function pending(sandboxId: string) {
  return (await db.select().from(driveMountRevocations).where(eq(driveMountRevocations.sandboxId, sandboxId))).length > 0;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'drive-enforcement' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'drive-enforcement',
    repoUrl: 'https://example.test/drive-enforcement.git',
    metadata: { experimental: { drives: true } },
  });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' });
  await db.insert(serviceAccounts).values({
    serviceAccountId: RESEARCHER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    agentName: 'researcher',
    name: 'researcher',
    secretHash: `drive-enforcement-${RESEARCHER}`,
    publicPrefix: 'kortix_sa_drive',
  });
  clearAuthorizeCaches();
  const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
  driveId = drive.driveId;
  researchGrant = await setFolderGrant({
    drive,
    path: '/Research',
    principal: { type: 'agent', id: RESEARCHER },
    level: 'write',
    grantedBy: OWNER,
  });
  ownerToken = (await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'drive-enforcement-owner' })).secretKey;
  await box(NATIVE, { provider: 'platinum', externalId: 'box-native', mounts: [mount('/Research'), mount('/Company')] });
  await box(SYNCED, { provider: 'daytona', externalId: 'box-synced', mounts: [mount('/Research'), mount('/Company')] });
  await box(FENCED, { provider: 'daytona', externalId: 'box-fenced', mounts: [mount('/Research'), mount('/Company')] });
  await box(RESUMED, { provider: 'platinum', externalId: 'box-resumed', mounts: [] });
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a block upload is authorized by the paths its plan writes', () => {
  test('a plan whose folder turned read-only commits nothing, and a commit cannot name another path', async () => {
    const plan = await asBox(SYNCED, '/files/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ path: '/Research/big.bin', size: 3, blocks: ['a'.repeat(64)] }] }),
    });
    expect(plan.status).toBe(200);

    // The folder turns read-only for this box; /Company stays writable.
    await db
      .update(sessionSandboxes)
      .set({
        metadata: sql`${sessionSandboxes.metadata} || ${JSON.stringify({ driveMounts: [mount('/Research', true), mount('/Company')] })}::jsonb`,
      })
      .where(eq(sessionSandboxes.sandboxId, SYNCED));
    calls.length = 0;

    const block = await asBox(SYNCED, `/files/upload/up-1/blocks/${'a'.repeat(64)}`, { method: 'PUT', body: new Uint8Array(3) });
    expect(block.status).toBe(403);
    const commit = await asBox(SYNCED, '/files/upload/up-1/commit', { method: 'POST' });
    expect(commit.status).toBe(403);
    const elsewhere = await asBox(SYNCED, `/files/upload/up-1/commit?path=${encodeURIComponent('/Company/big.bin')}`, { method: 'POST' });
    expect(elsewhere.status).not.toBe(200);
    expect(calls).toEqual([]);
  });
});

describe('a revocation whose detach fails', () => {
  test('answers 202 with the session pending, and the worker retries the detach until it lands', async () => {
    detachFails = true;
    calls.length = 0;
    const res = await asOwner(`/v1/drives/${driveId}/access/${researchGrant}`, { method: 'DELETE' });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { pendingSessions: number }).pendingSessions).toBeGreaterThanOrEqual(1);
    expect(calls).toContain('detach /drives/research');
    expect(await pending(NATIVE)).toBe(true);
    expect(await recordedMounts(NATIVE)).toContainEqual(['/Research', false]);
    expect((await listFolderGrants(await ensureProjectDrive(ACCOUNT, PROJECT))).some((g) => g.grantId === researchGrant)).toBe(false);

    // The provider answers again; the worker's next pass lands the detach.
    detachFails = false;
    await db.update(driveMountRevocations).set({ notBefore: new Date(0) });
    await retryPendingRevocations();
    expect(await pending(NATIVE)).toBe(false);
    expect(await recordedMounts(NATIVE)).toEqual([['/Company', false]]);
  });

  test('while pending, the sync routes refuse the folder the session lost', async () => {
    // FENCED's record still has /Research read-write (its rewrite has not
    // landed), but no grant reaches the folder any more.
    await db
      .update(sessionSandboxes)
      .set({ metadata: sql`${sessionSandboxes.metadata} || ${JSON.stringify({ driveMounts: [mount('/Research'), mount('/Company')] })}::jsonb` })
      .where(eq(sessionSandboxes.sandboxId, FENCED));
    const research = encodeURIComponent('/Research');
    // Not pending: the record is what the box was given, and is honored as such.
    expect((await asBox(FENCED, `/files?path=${research}`)).status).toBe(200);
    await db.insert(driveMountRevocations).values({ sandboxId: FENCED, notBefore: new Date(Date.now() + 60_000) }).onConflictDoNothing();
    expect((await asBox(FENCED, `/files?path=${research}`)).status).toBe(404);
    expect(
      (await asBox(FENCED, `/files/content?path=${encodeURIComponent('/Research/a.md')}`, { method: 'PUT', body: 'x' })).status,
    ).toBe(404);
    expect((await asBox(FENCED, `/files?path=${encodeURIComponent('/Company')}`)).status).toBe(200);
    const answer = await app.request(`/v1/projects/${PROJECT}/sessions/${FENCED}/drive-sync/mounts`, {
      headers: { Authorization: `Bearer ${sessionTokens[FENCED]}` },
    });
    const mounts = (await answer.json()) as { mounts: Array<{ subdir?: string }> };
    expect(mounts.mounts.map((m) => m.subdir)).toEqual(['/Company']);
  });
});

describe('who may change folder access', () => {
  test('a session credential cannot share a folder or change a session’s mounts, even its launcher’s', async () => {
    // The session token acts for the person who launched it; it still may not
    // grant itself (or its agent) more of the project's Files.
    const share = await app.request(`/v1/drives/${driveId}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${sessionTokens[SYNCED]}` },
      body: JSON.stringify({ path: '/Research', principalType: 'agent', principalId: 'researcher', level: 'manage' }),
    });
    expect(share.status).toBe(403);
    // A session has no route of its own that attaches a folder or changes its access:
    // what it mounts follows grants only.
    for (const method of ['POST', 'PATCH']) {
      const res = await app.request(`/v1/projects/${PROJECT}/sessions/${SYNCED}/drives${method === 'PATCH' ? `/${driveId}` : ''}`, {
        method,
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${sessionTokens[SYNCED]}` },
        body: JSON.stringify(method === 'PATCH' ? { access: 'write' } : { driveId, readOnly: false }),
      });
      expect([404, 405]).toContain(res.status);
    }
    expect((await listFolderGrants(await ensureProjectDrive(ACCOUNT, PROJECT))).some((g) => g.path === '/Research' && g.level === 'manage')).toBe(false);
  });
});

describe('a resumed sandbox whose guest kept mounts Platinum ended', () => {
  test('reconcile clears the stale mounts and attaches the folders, and records them', async () => {
    staleGuest.clear();
    staleGuest.add('/drives/me');
    staleGuest.add('/drives/company');
    calls.length = 0;
    await reconcileSessionDrives(RESUMED);
    const attached = calls.filter((c) => c.startsWith('attach ')).map((c) => c.slice('attach '.length));
    expect(attached.length).toBeGreaterThan(0);
    expect(attached.some((p) => p === '/drives/me' || p === '/drives/company')).toBe(true);
    for (const p of attached) {
      if (p === '/drives/me' || p === '/drives/company') expect(calls.indexOf(`unmount ${p}`)).toBeLessThan(calls.indexOf(`attach ${p}`));
    }
    expect((await recordedMounts(RESUMED)).length).toBe(attached.length);
    expect(await pending(RESUMED)).toBe(false);
  });
});
