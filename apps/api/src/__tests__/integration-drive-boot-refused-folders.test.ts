/**
 * Integration test (real local DB, real drive worker): a Files folder that
 * storage refused when the session's box was created never stops the box,
 * and does not stay missing.
 *
 *   - The session names the folder as not mounted yet, with why.
 *   - The drive worker attaches it to the running box, and keeps trying with
 *     backoff while storage still refuses it.
 *   - A folder too large to mount is recorded once and not retried.
 *
 * Prod 2026-11-01: one folder's mount image failed to build, and every create
 * of every session that mounted it failed for ~5 h. Storage and the provider
 * are faked at the volumes module; grants, the worker and the DB are real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, accounts, driveMountRevocations, projectSessions, projects, serviceAccounts, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import * as realVolumes from '../drives/volumes';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

/** What storage answers an attach at a mount path; absent = it mounts. */
const refuse = new Map<string, Error>();
const attached: string[] = [];

mock.module('../drives/volumes', () => ({
  ...realVolumes,
  driveStorageAvailable: () => true,
  openDriveVolume: async (name: string) => ({ name, id: 'vol', head_commit_id: null }),
  getDriveVolume: async (name: string) => ({ name, id: 'vol', head_commit_id: 'c0' }),
  sandboxMountLimit: async () => 8,
  sandboxMountPaths: async () => [],
  sandboxVolumeMounts: async () => [],
  attachSandboxVolume: async (_box: string, mountPath: string) => {
    const err = refuse.get(mountPath);
    if (err) throw err;
    attached.push(mountPath);
  },
  detachSandboxVolume: async () => {},
  unmountInGuest: async () => {},
  execInSandbox: async () => {},
}));

(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';

await import('../index');
const { ensureProjectDrive, setFolderGrant, queueDriveAttach, readSkippedSessionDrives } = await import('../drives/service');
const { retryPendingRevocations } = await import('../worker/jobs/drive');
const { clearAuthorizeCaches } = await import('../iam/authorize');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const DERIVING = crypto.randomUUID(); // its folder image did not build at boot
const TOO_BIG = crypto.randomUUID(); // its folder is larger than a mount allows
let driveId = '';

const storageRefused = () =>
  new realVolumes.DriveStorageError(503, 'deriving the sub_path image failed: volimg: scratch image over budget', 'unavailable');
const tooLarge = () =>
  new realVolumes.DriveStorageError(413, 'This folder is too large to mount in a session', 'sub_path_too_large');

async function bootedWithout(sessionId: string, folder: string) {
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: OWNER,
    visibility: 'project',
    origin: 'trigger',
    agentName: 'editor',
  });
  // What recordAttemptBoot writes for a box Platinum created without the folder.
  await db.insert(sessionSandboxes).values({
    sandboxId: sessionId,
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    provider: 'platinum',
    externalId: `box-${sessionId.slice(0, 8)}`,
    status: 'active',
    config: {},
    metadata: {
      driveMounts: [],
      driveMountsSkipped: [{ driveId, name: folder, reason: 'unavailable', detail: 'deriving the sub_path image failed' }],
    },
  });
}

async function mountedFolders(sandboxId: string) {
  const [row] = await db.select({ metadata: sessionSandboxes.metadata }).from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId));
  return ((row?.metadata as { driveMounts?: Array<{ subdir: string }> }).driveMounts ?? []).map((m) => m.subdir);
}

async function revocation(sandboxId: string) {
  const [row] = await db.select().from(driveMountRevocations).where(eq(driveMountRevocations.sandboxId, sandboxId));
  return row ?? null;
}

/** The worker's next pass for this box runs now, not after its backoff. */
async function workerPass(sandboxId: string) {
  await db.update(driveMountRevocations).set({ notBefore: new Date(Date.now() - 1_000) }).where(eq(driveMountRevocations.sandboxId, sandboxId));
  await retryPendingRevocations();
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'drive-boot-refused' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'drive-boot-refused',
    repoUrl: 'https://example.test/drive-boot-refused.git',
    metadata: { experimental: { volumes: true } },
  });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' });
  await db.insert(serviceAccounts).values({
    serviceAccountId: AGENT,
    accountId: ACCOUNT,
    projectId: PROJECT,
    agentName: 'editor',
    name: 'editor',
    secretHash: `drive-boot-refused-${AGENT}`,
    publicPrefix: 'kortix_sa_dbr',
  });
  clearAuthorizeCaches();
  const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
  driveId = drive.driveId;
  await setFolderGrant({ drive, path: '/Video', principal: { type: 'agent', id: AGENT }, level: 'write', grantedBy: OWNER });
  await bootedWithout(DERIVING, '/Video');
  await bootedWithout(TOO_BIG, '/Video');
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a folder storage refused when the box was created', () => {
  test('is named as not mounted yet, retried with backoff while refused, then attached by the drive worker', async () => {
    const before = await readSkippedSessionDrives(DERIVING);
    expect(before.message).toContain('not mounted yet');
    expect(before.message).toContain('/Video');

    refuse.set('/drives/video', storageRefused());
    await queueDriveAttach(DERIVING, '1 folder(s) refused at boot');
    await workerPass(DERIVING);
    const stillRefused = await revocation(DERIVING);
    expect(stillRefused).not.toBeNull();
    expect(stillRefused!.attempts).toBeGreaterThanOrEqual(1);
    expect(stillRefused!.notBefore.getTime()).toBeGreaterThan(Date.now());
    expect(await mountedFolders(DERIVING)).not.toContain('/Video');

    refuse.clear();
    await workerPass(DERIVING);
    expect(attached).toContain('/drives/video');
    expect(await mountedFolders(DERIVING)).toContain('/Video');
    expect(await revocation(DERIVING)).toBeNull();
    expect((await readSkippedSessionDrives(DERIVING)).message).toBeNull();
  });

  test('too large to mount: recorded once with why, and not retried', async () => {
    refuse.set('/drives/video', tooLarge());
    await queueDriveAttach(TOO_BIG, '1 folder(s) refused at boot');
    await workerPass(TOO_BIG);
    expect(await revocation(TOO_BIG)).toBeNull();
    expect(await mountedFolders(TOO_BIG)).not.toContain('/Video');
    const after = await readSkippedSessionDrives(TOO_BIG);
    expect(after.skipped).toEqual([expect.objectContaining({ name: '/Video', reason: 'too_large' })]);
    expect(after.message).toContain('too large to mount');
    refuse.clear();
  });
});
