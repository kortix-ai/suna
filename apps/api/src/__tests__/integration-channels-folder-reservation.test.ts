/**
 * Integration test (real local DB, real routes, fake storage): a folder a
 * person made at `/Channels` in Files is an ordinary folder, with the
 * `chat` flag off and on. Only `/Channels/<space_id>` of a private
 * channel of the project is reserved (prod-readiness finding 1: the branch
 * reserved all of `/Channels` in every project).
 *
 * OFF: a project with the flag off and no private channel. ON: a project with
 * the flag on and one private channel, P (members: ALICE). In both, BOB made
 * `/Channels/notes` and holds a manual `write` grant on it. MANAGER is a
 * project manager (a Files admin) outside P.
 *
 * Storage and the provider are faked at the volumes module; routes, grants,
 * membership and the DB are real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, accounts, projectMembers, projectSessions, projectSpaceMembers, projectSpaces, projects, serviceAccounts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import * as realVolumes from '../drives/volumes';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

/** What `GET files?path=` lists, by folder. */
const listing: Record<string, Array<{ path: string; type: 'dir' | 'file'; size: number; mtime: number }>> = {};

mock.module('../drives/volumes', () => ({
  ...realVolumes,
  driveStorageAvailable: () => true,
  openDriveVolume: async (name: string) => ({ name, id: 'vol', head_commit_id: null }),
  getDriveVolume: async (name: string) => ({ name, id: 'vol', head_commit_id: 'c0' }),
  sandboxMountLimit: async () => 8,
  sandboxMountPaths: async () => [],
  sandboxVolumeMounts: async () => [],
  attachSandboxVolume: async () => {},
  unmountInGuest: async () => {},
  detachSandboxVolume: async () => {},
  execInSandbox: async () => {},
  listVolumeFiles: async (_v: string, path: string) => listing[path] ?? [],
}));
(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { driveSubjectFor, ensureProjectDrive, listFolderGrants, planSessionDrives, setFolderGrant } = await import('../drives/service');
const { folderAccess } = await import('../drives/folders');
const { afterPrivateChannelChange } = await import('../drives/space-folders');

const ACCOUNT = crypto.randomUUID();
const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const CAROL = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const USERS = [ALICE, BOB, CAROL, MANAGER];
const NOTES = '/Channels/notes';
/** The agent `/Channels/notes` is shared with: since #11606 a folder is shared with an agent, never a person. */
const EDITOR = 'editor';
const P = crypto.randomUUID();
const P_FOLDER = `/Channels/${P}`;
const minted: string[] = [];

type Fixture = { projectId: string; driveId: string; bobThread: string; editorThread: string; agent: string; keys: Record<string, string> };
const fixtures: Record<'off' | 'on', Fixture> = {
  off: { projectId: crypto.randomUUID(), driveId: '', bobThread: crypto.randomUUID(), editorThread: crypto.randomUUID(), agent: crypto.randomUUID(), keys: {} },
  on: { projectId: crypto.randomUUID(), driveId: '', bobThread: crypto.randomUUID(), editorThread: crypto.randomUUID(), agent: crypto.randomUUID(), keys: {} },
};

/** A project member; `admin` may change the project (a Files admin). */
const may = (admin: boolean) => async (action: 'session' | 'write') => (action === 'write' ? admin : true);

async function mint(projectId: string, userId: string): Promise<string> {
  const t = await createAccountToken({ accountId: ACCOUNT, userId, projectId, name: 'channels-folder-reservation', agentGrant: null as any });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function req(method: string, path: string, secret: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

const driveOf = async (f: Fixture) => (await ensureProjectDrive(ACCOUNT, f.projectId))!;
const accessAt = async (f: Fixture, userId: string, path: string, admin = false) => {
  const caller = await driveSubjectFor(await driveOf(f), userId, may(admin), null);
  return folderAccess(path, caller.grants, caller.subject);
};

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'channels-folder-reservation' });
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(
    db,
    accountMembers,
    USERS.map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })),
  );
  for (const [mode, f] of Object.entries(fixtures) as Array<['off' | 'on', Fixture]>) {
    const metadata = { experimental: { drives: true, shared_drives: true, chat: mode === 'on' } };
    await db.insert(projects).values({ splitPending: true, projectId: f.projectId, accountId: ACCOUNT, name: `reservation-${mode}`, repoUrl: 'https://example.test/r.git', metadata });
    await insertIntoView(db, projectMembers, [
      { accountId: ACCOUNT, projectId: f.projectId, userId: MANAGER, projectRole: 'manager' },
      ...[ALICE, BOB, CAROL].map((userId) => ({ accountId: ACCOUNT, projectId: f.projectId, userId, projectRole: 'member' as const })),
    ]);
    // Bob's own private session: a personal session mounts what is shared with him.
    await db.insert(projectSessions).values({
      accountId: ACCOUNT,
      projectId: f.projectId,
      agentName: 'kortix',
      sessionId: f.bobThread,
      branchName: f.bobThread,
      createdBy: BOB,
      visibility: 'private',
      origin: 'user',
      metadata: {},
    });
    // The editor agent and one of its sessions: a shared Drive reaches a session through its agent.
    await db.insert(serviceAccounts).values({
      serviceAccountId: f.agent,
      accountId: ACCOUNT,
      projectId: f.projectId,
      agentName: EDITOR,
      name: EDITOR,
      secretHash: `channels-folder-reservation-${f.agent}`,
      publicPrefix: 'kortix_sa_cfr',
    });
    await db.insert(projectSessions).values({
      accountId: ACCOUNT,
      projectId: f.projectId,
      agentName: EDITOR,
      sessionId: f.editorThread,
      branchName: f.editorThread,
      createdBy: BOB,
      visibility: 'private',
      origin: 'user',
      metadata: {},
    });
    const drive = await driveOf(f);
    f.driveId = drive.driveId;
    await setFolderGrant({ drive, path: NOTES, principal: { type: 'agent', id: f.agent }, level: 'write', grantedBy: MANAGER, source: 'manual' });
    f.keys.bob = await mint(f.projectId, BOB);
    f.keys.manager = await mint(f.projectId, MANAGER);
  }
  // ON: one private channel, its member grant written the way create writes it.
  await db.insert(projectSpaces).values({
    spaceId: P,
    accountId: ACCOUNT,
    projectId: fixtures.on.projectId,
    kind: 'channel',
    slug: `deals-${P.slice(0, 6)}`,
    name: 'deals',
    createdBy: ALICE,
    visibility: 'private',
  });
  await db.insert(projectSpaceMembers).values({ spaceId: P, userId: ALICE, addedBy: ALICE });
  await afterPrivateChannelChange(fixtures.on.projectId, { enforce: false });
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.execute(sql`delete from kortix.role_assignments where account_id = ${ACCOUNT}::uuid`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

for (const mode of ['off', 'on'] as const) {
  describe(`chat ${mode}: a person-made /Channels/notes is an ordinary folder`, () => {
    const f = fixtures[mode];

    test('an admin manages it like any folder', async () => {
      expect(await accessAt(f, MANAGER, `${NOTES}/plan.md`, true)).toBe('manage');
    });

    test('a private-channel grant sync never deletes its agent grant', async () => {
      await afterPrivateChannelChange(f.projectId, { enforce: false });
      const grants = (await listFolderGrants(await driveOf(f))).filter((g) => g.path === NOTES);
      expect(grants.map((g) => [g.principalId, g.level])).toEqual([[f.agent, 'write']]);
    });

    test('the agent’s session mounts it read-write', async () => {
      const plan = await planSessionDrives({ accountId: ACCOUNT, projectId: f.projectId, sessionId: f.editorThread, bootingUserId: BOB, agentName: EDITOR, slots: 16 });
      expect(plan.mounts.find((m) => m.path === NOTES)).toMatchObject({ readOnly: false });
    });

    test('HTTP: the manager may share it, and shares it with the agent', async () => {
      const access = await req('GET', `/v1/drives/${f.driveId}/access?path=${encodeURIComponent(NOTES)}`, f.keys.manager!);
      expect(access.status).toBe(200);
      expect(access.body.grantable).toBe(true);
      const shared = await req('PUT', `/v1/drives/${f.driveId}/access`, f.keys.manager!, { path: NOTES, principalType: 'agent', principalId: EDITOR, level: 'read' });
      expect(shared.status).toBe(200);
    });
  });
}

describe('chat on: the private channel folder stays reserved', () => {
  const f = fixtures.on;

  test('only its member reaches it; the manager and Bob get nothing', async () => {
    expect(await accessAt(f, ALICE, `${P_FOLDER}/a.md`)).toBe('write');
    expect(await accessAt(f, BOB, `${P_FOLDER}/a.md`)).toBe('none');
    expect(await accessAt(f, MANAGER, `${P_FOLDER}/a.md`, true)).toBe('none');
  });

  test('it cannot be shared, nor /Channels that holds it', async () => {
    for (const path of [P_FOLDER, '/Channels']) {
      // A valid agent share, so a refusal is the reservation, not request validation.
      const res = await req('PUT', `/v1/drives/${f.driveId}/access`, f.keys.manager!, { path, principalType: 'agent', principalId: EDITOR, level: 'read' });
      expect([400, 403, 404]).toContain(res.status);
    }
  });

  test('a stray grant inside it is removed by the sync; the agent’s /Channels/notes grant stays', async () => {
    const drive = await driveOf(f);
    await setFolderGrant({ drive, path: `${P_FOLDER}/x`, principal: { type: 'agent', id: f.agent }, level: 'write', grantedBy: null, source: 'manual' });
    await afterPrivateChannelChange(f.projectId, { enforce: false });
    const paths = (await listFolderGrants(drive)).filter((g) => g.path.startsWith('/Channels')).map((g) => `${g.path} ${g.principalId}`).sort();
    expect(paths).toEqual([`${NOTES} ${f.agent}`, `${P_FOLDER} ${ALICE}`].sort());
  });

  test('Bob’s session never mounts the private channel folder', async () => {
    const plan = await planSessionDrives({ accountId: ACCOUNT, projectId: f.projectId, sessionId: f.bobThread, bootingUserId: BOB, agentName: 'kortix', slots: 16 });
    expect(plan.mounts.some((m) => m.path.startsWith(P_FOLDER))).toBe(false);
  });
});
