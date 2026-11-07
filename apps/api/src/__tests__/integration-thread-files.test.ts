/**
 * Integration test (real local DB, fake Drive volume): a space thread's files.
 * The conversation is never copied into the Drive: a turn writes only the
 * space's context.md, and every session of the thread (its worker too) is told
 * the thread's root session (its log is the conversation), the thread folder,
 * and mounts the channel folder (`planSessionDrives`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projectSpaces, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { ensureProjectDrive, planSessionDrives, sessionMountsSpaceFiles } from '../drives/service';
import { threadFilesTurn } from '../memory/thread-files';
import { setVolumeOpsForTests } from '../memory/volume-ops';
import { config } from '../config';
import { db } from '../shared/db';
import { FakeVolume } from './helpers/memory-fake-volume';

// This lane has no Platinum key; the fake volume stands in for the Drive, which needs one.
(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OFF_PROJECT = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const GENERAL = crypto.randomUUID();
const OFF_GENERAL = crypto.randomUUID();
const ROUTER = crypto.randomUUID();
const WORKER = crypto.randomUUID();
const OFF_THREAD = crypto.randomUUID();
const volume = new FakeVolume();
const short = ROUTER.replace(/-/g, '').slice(0, 8);
const DIR = `/Company/Channels/general/threads/write-a-poem-about-rain-${short}`;
const BOX = `/drives/general/threads/write-a-poem-about-rain-${short}`;
/** context.md is written off the turn's path: wait for it. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeAll(async () => {
  setVolumeOpsForTests(volume);
  await db.execute(sql`INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES (${PRIYA}::uuid, ${`thread-files-${PRIYA.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'thread-files' });
  await db.insert(projects).values([
    { splitPending: true, projectId: PROJECT, accountId: ACCOUNT, name: 'thread-files', repoUrl: 'https://example.test/t.git', metadata: { experimental: { chat: true } } },
    { splitPending: true, projectId: OFF_PROJECT, accountId: ACCOUNT, name: 'thread-files-off', repoUrl: 'https://example.test/o.git', metadata: {} },
  ]);
  await db.insert(projectSpaces).values([
    { spaceId: GENERAL, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'general', name: 'general', isDefault: true },
    { spaceId: OFF_GENERAL, accountId: ACCOUNT, projectId: OFF_PROJECT, kind: 'channel', slug: 'general', name: 'general', isDefault: true },
  ]);
  await db.insert(projectSessions).values([
    { sessionId: ROUTER, accountId: ACCOUNT, projectId: PROJECT, branchName: 'r', createdBy: PRIYA, agentName: 'mykortix', spaceId: GENERAL, visibility: 'project', metadata: { first_prompt: 'Write a poem about rain' } },
    { sessionId: WORKER, accountId: ACCOUNT, projectId: PROJECT, branchName: 'w', createdBy: PRIYA, agentName: 'mykortix', spaceId: GENERAL, visibility: 'project', parentSessionId: ROUTER, metadata: { agent_handle: 'poem' } },
    { sessionId: OFF_THREAD, accountId: ACCOUNT, projectId: OFF_PROJECT, branchName: 'o', createdBy: PRIYA, agentName: 'mykortix', spaceId: OFF_GENERAL, visibility: 'project' },
  ]);
  const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
  const mounts = { driveMounts: [{ driveId: drive.driveId, kind: 'project', mountPath: '/drives/general', readOnly: false, subdir: '/Company/Channels/general', role: 'drive' }] };
  await db.insert(sessionSandboxes).values([
    { sandboxId: crypto.randomUUID(), sessionId: ROUTER, accountId: ACCOUNT, projectId: PROJECT, externalId: 'sandbox-thread-router', status: 'active', metadata: mounts },
    { sandboxId: crypto.randomUUID(), sessionId: WORKER, accountId: ACCOUNT, projectId: PROJECT, externalId: 'sandbox-thread-worker', status: 'active', metadata: mounts },
  ]);
});

afterAll(async () => {
  setVolumeOpsForTests(null);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, OFF_PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`DELETE FROM auth.users WHERE id = ${PRIYA}::uuid`);
});

describe('a #general thread: one conversation (the session log), a shared folder for work', () => {
  test('a router turn names its session, the thread folder and context.md; only context.md is written', async () => {
    const turn = await threadFilesTurn({ sessionId: ROUTER });
    expect(turn?.files).toEqual({ folder: BOX, context: '/drives/general/context.md', session: ROUTER });
    expect(turn?.system).toContain(`The conversation: session ${ROUTER}. Read it with \`kortix sessions log ${ROUTER} -n 50\``);
    expect(turn?.system).toContain(`- Thread folder: ${BOX}/`);
    await until(() => volume.files.has('/Company/Channels/general/context.md'));
    expect(volume.files.get('/Company/Channels/general/context.md')?.text).toBe('# #general: context\n');
    // No copy of any message: the thread folder holds only what agents write.
    expect([...volume.files.keys()].filter((path) => path.startsWith(DIR))).toEqual([]);
  });

  test('a second turn keeps the same folder and writes nothing; the root session metadata is not touched', async () => {
    const before = [...volume.files.keys()].sort();
    const turn = await threadFilesTurn({ sessionId: ROUTER });
    expect(turn?.files?.folder).toBe(BOX);
    await new Promise((r) => setTimeout(r, 50));
    expect([...volume.files.keys()].sort()).toEqual(before);
    const [router] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(eq(projectSessions.sessionId, ROUTER));
    expect(router?.metadata).toEqual({ first_prompt: 'Write a poem about rain' });
  });

  test('a worker is told the conversation (its router session), the thread folder and its own work folder', async () => {
    const turn = await threadFilesTurn({ sessionId: WORKER });
    expect(turn?.files).toBeNull();
    expect(turn?.system).toContain(`The conversation: session ${ROUTER}.`);
    expect(turn?.system).toContain(`- Thread folder: ${BOX}/`);
    expect(turn?.system).toContain(`- Your work folder: ${BOX}/work/poem/ (scratch files; your full result goes to ${BOX}/results/poem-<n>.md, <n> the next free number from 1)`);
  });

  test('every session of the thread mounts the channel folder read-write; with chat off, nothing is mounted', async () => {
    for (const sessionId of [ROUTER, WORKER]) {
      const plan = await planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId, bootingUserId: PRIYA, agentName: 'mykortix', slots: 16 });
      expect(plan.mounts.map((m) => `${m.path}@${m.mountPath}${m.readOnly ? ':ro' : ''}`)).toContain('/Company/Channels/general@/drives/general');
    }
    // A My Kortix box, which mounts no Files elsewhere, mounts them in a space thread with chat on.
    expect(await sessionMountsSpaceFiles(PROJECT, ROUTER)).toBe(true);
    expect(await sessionMountsSpaceFiles(OFF_PROJECT, OFF_THREAD)).toBe(false);
    const off = await planSessionDrives({ accountId: ACCOUNT, projectId: OFF_PROJECT, sessionId: OFF_THREAD, bootingUserId: PRIYA, agentName: 'mykortix', slots: 16 });
    expect(off.mounts.map((m) => m.path)).not.toContain('/Company/Channels/general');
  });
});
