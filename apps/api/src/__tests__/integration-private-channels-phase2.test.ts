/**
 * Integration test (real local DB, real routes, fake storage): private
 * channels. Each test is named after the way a private thread could leak that
 * it closes: memory, the note label, the Drive path, thread mounts, a removed
 * member's mounts, plus link collection, the unfurl cache, conversion's folder
 * move and the trigger actor.
 *
 * People: ALICE (creator of P, member), CAROL (member of P, removed below),
 * BOB (project member, not in P), MANAGER (project manager, not in P), OWNER
 * (account owner, not in P). P is a private channel written directly; the
 * conversion test calls `updateChannel` directly (the routes keep their own
 * availability gate).
 *
 * Storage and the provider are faked at the volumes module and the memory
 * volume seam; routes, grants, membership and the DB are real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  artifacts as artifactsTable,
  drives,
  projectMembers,
  projectSessions,
  projectSpaceLinks,
  projectSpaceMembers,
  projectSpaces,
  projectTriggerRuntime,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import * as realVolumes from '../drives/volumes';
import * as registry from '../feature-flags/registry';
import { config } from '../config';
import { db } from '../shared/db';
import { FakeVolume } from './helpers/memory-fake-volume';
import { insertIntoView } from './helpers/compat-views';

const moves: string[] = [];
/** Every path the fake storage was asked to write. */
const written: string[] = [];
const restored: string[] = [];
/** The Files versions the restore route reads, newest first. */
const commits: Array<{ id: string; kind: string; created_at: string; author: null }> = [];
const detached: string[] = [];
let moveFails = false;
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
  detachSandboxVolume: async (box: string, mountPath: string) => {
    detached.push(`${box} ${mountPath}`);
  },
  execInSandbox: async () => {},
  writeVolumeFile: async (_v: string, path: string, body: Uint8Array) => {
    written.push(path);
    return { path, size: body.byteLength };
  },
  writeVolumeFiles: async (_v: string, files: Array<{ path: string }>) => {
    written.push(...files.map((f) => f.path));
    return { commit_id: 'c1' };
  },
  listVolumeFiles: async (_v: string, path: string) => listing[path] ?? [],
  statVolumeFile: async (_v: string, path: string) => {
    if (path.endsWith('/deck')) return { path, type: 'dir', size: 0, mtime: 0 };
    if (path.endsWith('/deck/index.md')) return { path, type: 'file', size: 6, mtime: 0, version: 'v1' };
    throw new realVolumes.DriveStorageError(404, 'not found');
  },
  readVolumeFile: async () => new Response('# Deck'),
  listVolumeCommits: async () => commits,
  restoreVolume: async (_v: string, to: string) => {
    restored.push(to);
  },
  moveVolumeFile: async (_v: string, from: string, to: string) => {
    if (moveFails) throw new realVolumes.DriveStorageError(503, 'storage is down');
    moves.push(`${from} -> ${to}`);
  },
}));
// This lane has no Platinum key, so `drives` is never available here; the fakes stand in for it.
const resolveFeatureFlag = registry.resolveFeatureFlag;
mock.module('../feature-flags/registry', () => ({
  ...registry,
  resolveFeatureFlag: (metadata: unknown, key: string) =>
    key === 'drives' ? Boolean((metadata as { experimental?: { drives?: boolean } } | null)?.experimental?.drives) : resolveFeatureFlag(metadata, key as never),
}));
(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { driveSubjectFor, ensureProjectDrive, listFolderGrants, planSessionDrives, recordedDriveMounts } = await import('../drives/service');
const { folderAccess } = await import('../drives/folders');
const { afterPrivateChannelChange } = await import('../drives/space-folders');
const { resolveLayer, threadLabelOf } = await import('../memory/layers');
const { searchMemory } = await import('../memory/search');
const { memoryTurnContext } = await import('../memory/turn-context');
const { setVolumeOpsForTests } = await import('../memory/volume-ops');
const { collectMessageLinks } = await import('../projects/lib/project-space-links');
const { unfurlLink } = await import('../projects/lib/link-unfurl');
const { updateChannel } = await import('../projects/lib/project-spaces');
const { spaceAccessFor } = await import('../shared/space-access');
const { fireGitTrigger, privateChannelRunActor } = await import('../projects/lib/trigger-fire');
const { resolveTriggerSpaceCreate, resolveTriggerSpacePatch } = await import('../projects/lib/trigger-space');
const { canView, listArtifacts, share, updateArtifactMeta } = await import('../artifacts/service');
const { privateChannelFoldersFor, sessionPrivateChannelFolder, setFolderGrant } = await import('../drives/service');
const { spaceDriveFolders } = await import('@kortix/shared');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ALICE = crypto.randomUUID();
const CAROL = crypto.randomUUID();
const BOB = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const USERS = [ALICE, CAROL, BOB, MANAGER, OWNER];
const P = crypto.randomUUID();
const SLUG = `deals-${P.slice(0, 6)}`;
const FOLDER = `/Channels/${P}`;
const PUBLIC_C = crypto.randomUUID();
const CONV = crypto.randomUUID();
const CONV_SLUG = `conv-${P.slice(0, 6)}`;
const P_THREAD = crypto.randomUUID();
const GENERAL_THREAD = crypto.randomUUID();
const WORD = `zebracorn${P.slice(0, 6)}`;
const metadata = { experimental: { project_channels: true, drives: true, artifacts: true } };
/** Alice's own private thread in P: a personal session, so its token passes the Files middleware. */
const P_PRIVATE_THREAD = crypto.randomUUID();
const project = { projectId: PROJECT, accountId: ACCOUNT, metadata };
const minted: string[] = [];
const keys: Record<string, string> = {};
const volume = new FakeVolume();
let general = '';
let driveId = '';

/** A project member; `admin` may change the project. */
const person = (userId: string, admin = false) => ({ userId, may: async (action: 'session' | 'write') => (action === 'write' ? admin : true) });

async function mint(userId: string, sessionId?: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'private-channels-phase2',
    agentGrant: null as any,
    ...(sessionId ? { sessionId } : {}),
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function req(method: string, path: string, secret: string, body?: unknown) {
  const res = await app.request(path.startsWith('/v1/') ? path : `/v1/projects/${PROJECT}${path}`, {
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

const accessAt = async (userId: string, path: string, opts: { admin?: boolean; bound?: string } = {}) => {
  const drive = (await ensureProjectDrive(ACCOUNT, PROJECT))!;
  const caller = await driveSubjectFor(drive, userId, person(userId, opts.admin).may, opts.bound ?? null);
  return folderAccess(path, caller.grants, caller.subject);
};

const box = (sessionId: string, status: 'active' | 'stopped', mounts: unknown[] = []) => ({
  sandboxId: crypto.randomUUID(),
  sessionId,
  accountId: ACCOUNT,
  projectId: PROJECT,
  provider: 'platinum' as const,
  externalId: `pc2-${sessionId.slice(0, 8)}`,
  status,
  config: {},
  metadata: { driveMounts: mounts },
});

const generalBox = box(GENERAL_THREAD, 'active');
const pBox = box(P_THREAD, 'active');
const setBox = (b: { sandboxId: string }, status: 'active' | 'stopped', mounts: unknown[]) =>
  db.update(sessionSandboxes).set({ status, metadata: { driveMounts: mounts } }).where(eq(sessionSandboxes.sandboxId, b.sandboxId));

beforeAll(async () => {
  setVolumeOpsForTests(volume);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'private-channels-phase2' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'Northwind', repoUrl: 'https://example.test/n.git', metadata });
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(db, accountMembers, [
    ...[ALICE, CAROL, BOB, MANAGER].map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })),
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' as const, isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    ...[ALICE, CAROL, BOB].map((userId) => ({ accountId: ACCOUNT, projectId: PROJECT, userId, projectRole: 'member' as const })),
  ]);
  keys.alice = await mint(ALICE);
  keys.bob = await mint(BOB);
  keys.manager = await mint(MANAGER);
  general = (await req('GET', '/spaces', keys.alice)).body.spaces.find((s: any) => s.is_default).space_id;
  await db.insert(projectSpaces).values([
    { spaceId: P, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: SLUG, name: SLUG, createdBy: ALICE, visibility: 'private' },
    { spaceId: PUBLIC_C, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `ops-${P.slice(0, 6)}`, name: 'ops', createdBy: BOB },
    { spaceId: CONV, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: CONV_SLUG, name: CONV_SLUG, createdBy: ALICE },
  ]);
  await db.insert(projectSpaceMembers).values([
    { spaceId: P, userId: ALICE, addedBy: ALICE },
    { spaceId: P, userId: CAROL, addedBy: ALICE },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'kortix', visibility: 'project' as const };
  await db.insert(projectSessions).values([
    { ...base, sessionId: P_THREAD, branchName: P_THREAD, createdBy: ALICE, spaceId: P, metadata: { first_prompt: `${WORD} acquisition plan` } },
    { ...base, sessionId: GENERAL_THREAD, branchName: GENERAL_THREAD, createdBy: ALICE, spaceId: general, metadata: {} },
    { ...base, sessionId: crypto.randomUUID(), branchName: 'conv', createdBy: BOB, spaceId: CONV, metadata: {} },
  ]);
  // The drive exists (the #general list made it); P's create path writes its member grants.
  driveId = (await ensureProjectDrive(ACCOUNT, PROJECT)).driveId;
  await afterPrivateChannelChange(PROJECT, { enforce: false });
  await db.insert(projectSessions).values({
    accountId: ACCOUNT,
    projectId: PROJECT,
    agentName: 'kortix',
    sessionId: P_PRIVATE_THREAD,
    branchName: P_PRIVATE_THREAD,
    createdBy: ALICE,
    visibility: 'private',
    origin: 'user',
    spaceId: P,
    metadata: {},
  });
  await db.insert(sessionSandboxes).values([generalBox, pBox, box(P_PRIVATE_THREAD, 'active')]);
  keys.pPrivate = await mint(ALICE, P_PRIVATE_THREAD);
  volume.put(`${FOLDER}/Memory/plan.md`, `# Plan\n\n${WORD}: buy the competitor.\n`);
  volume.put('/Company/Memory/launch.md', '# Launch\n\nShip in November.\n');
});

afterAll(async () => {
  setVolumeOpsForTests(null);
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.execute(sql`delete from kortix.role_assignments where account_id = ${ACCOUNT}::uuid`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

describe('the Drive path of a private channel', () => {
  test('each member holds a Kortix write grant on the folder; nobody else holds one', async () => {
    const drive = (await ensureProjectDrive(ACCOUNT, PROJECT))!;
    const grants = (await listFolderGrants(drive)).filter((g) => g.path.startsWith('/Channels'));
    expect(grants.map((g) => [g.path, g.principalId, g.level, g.source]).sort()).toEqual(
      [
        [FOLDER, ALICE, 'write', 'system'],
        [FOLDER, CAROL, 'write', 'system'],
      ].sort(),
    );
  });

  test('a member writes it; a non-member, a project admin and the account owner get nothing', async () => {
    expect(await accessAt(ALICE, `${FOLDER}/Memory/plan.md`)).toBe('write');
    expect(await accessAt(BOB, `${FOLDER}/Memory/plan.md`)).toBe('none');
    expect(await accessAt(MANAGER, `${FOLDER}/Memory/plan.md`, { admin: true })).toBe('none');
    expect(await accessAt(OWNER, `${FOLDER}/Memory/plan.md`, { admin: true })).toBe('none');
  });

  test('a session token reaches the folder only from a thread of the channel', async () => {
    expect(await accessAt(ALICE, `${FOLDER}/a.md`, { bound: GENERAL_THREAD })).toBe('none');
    expect(await accessAt(ALICE, `${FOLDER}/a.md`, { bound: P_THREAD })).toBe('write');
  });

  test('GET files: a non-member and a manager get 404 on the path and no /Channels in the root; a member lists it', async () => {
    listing['/'] = [
      { path: '/Company', type: 'dir', size: 0, mtime: 0 },
      { path: '/Channels', type: 'dir', size: 0, mtime: 0 },
    ];
    listing['/Channels'] = [{ path: FOLDER, type: 'dir', size: 0, mtime: 0 }];
    listing[FOLDER] = [{ path: `${FOLDER}/Memory`, type: 'dir', size: 0, mtime: 0 }];
    const files = (secret: string, path: string) => req('GET', `/v1/drives/${driveId}/files?path=${encodeURIComponent(path)}`, secret);
    for (const secret of [keys.bob!, keys.manager!]) {
      expect((await files(secret, FOLDER)).status).toBe(404);
      expect((await files(secret, '/Channels')).status).toBe(404);
      const root = await files(secret, '/');
      expect(root.status).toBe(200);
      expect(root.body.entries.map((e: any) => e.path)).not.toContain('/Channels');
    }
    const mine = await files(keys.alice!, FOLDER);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ access: 'write', entries: [{ path: `${FOLDER}/Memory` }] });
    // the folder is named by the channel's id and lists under its name.
    const channels = await files(keys.alice!, '/Channels');
    expect(channels.body.entries).toEqual([expect.objectContaining({ path: FOLDER, name: `#${SLUG}` })]);
    expect((await files(keys.alice!, '/')).body.entries.map((e: any) => e.path)).toContain('/Channels');
  });

  test('nobody shares anything inside /Channels', async () => {
    const res = await req('PUT', `/v1/drives/${driveId}/access`, keys.alice!, { path: FOLDER, principalType: 'user', principalId: BOB, level: 'read' });
    expect([400, 403, 404]).toContain(res.status);
    const inChannels = (await listFolderGrants((await ensureProjectDrive(ACCOUNT, PROJECT))!)).filter((g) => g.path.startsWith('/Channels'));
    expect(inChannels.some((g) => g.principalId === BOB)).toBe(false);
  });
});

describe('thread mounts', () => {
  test('a thread of P mounts its folder read-write; a #general thread of the same member mounts no /Channels folder', async () => {
    const plan = (sessionId: string) =>
      planSessionDrives({ accountId: ACCOUNT, projectId: PROJECT, sessionId, bootingUserId: ALICE, agentName: 'kortix', slots: 16 });
    const p = await plan(P_THREAD);
    expect(p.mounts.find((m) => m.path === FOLDER)).toMatchObject({ readOnly: false });
    // everything else is read-only in a private channel's thread.
    expect(p.mounts.filter((m) => m.path !== FOLDER).every((m) => m.readOnly)).toBe(true);
    expect(p.mounts.find((m) => m.path === '/Company')).toMatchObject({ readOnly: true });
    const g = await plan(GENERAL_THREAD);
    expect(g.mounts.some((m) => m.path.startsWith('/Channels'))).toBe(false);
    expect(g.mounts.map((m) => m.path)).toContain('/Company');
  });
});

describe('memory of a private channel', () => {
  test('a non-member and a manager get 404 on the layer; a member reads and writes /Channels/<slug>/Memory', async () => {
    await expect(resolveLayer(project, P, person(BOB))).rejects.toMatchObject({ status: 404, code: 'memory_not_found' });
    await expect(resolveLayer(project, P, person(MANAGER, true))).rejects.toMatchObject({ status: 404 });
    expect(await resolveLayer(project, P, person(ALICE))).toMatchObject({ root: `${FOLDER}/Memory`, canWrite: true });
    const http = await req('GET', `/memory/layers/${P}`, keys.bob!);
    expect(http.status).toBe(404);
  });

  test('memory search: a non-member gets no hit from P, a member does', async () => {
    expect((await searchMemory(project, person(BOB), { q: WORD, limit: 20 })).hits).toEqual([]);
    expect((await searchMemory(project, person(MANAGER, true), { q: WORD, limit: 20 })).hits).toEqual([]);
    await expect(searchMemory(project, person(BOB), { q: WORD, layer: P, limit: 20 })).rejects.toMatchObject({ status: 404 });
    expect((await searchMemory(project, person(ALICE), { q: WORD, limit: 20 })).hits.map((h) => h.layer_key)).toEqual([P]);
  });

  test('a #general thread’s turn list never names P; P’s own thread lists its memory at its mount', async () => {
    const company = { driveId, kind: 'project', mountPath: '/drives/company', readOnly: false, subdir: '/Company', role: 'drive' };
    await setBox(generalBox, 'active', [company]);
    await setBox(pBox, 'active', [company, { driveId, kind: 'project', mountPath: `/drives/${SLUG}`, readOnly: false, subdir: FOLDER, role: 'drive' }]);
    const own = (await memoryTurnContext(PROJECT, GENERAL_THREAD, ALICE))!.system;
    expect(own).not.toContain(SLUG);
    expect((await memoryTurnContext(PROJECT, P_THREAD, ALICE))!.system).toContain(`### #${SLUG}: /drives/${SLUG}/Memory/\n- plan (plan.md)`);
  });
});

describe('a note from a private thread', () => {
  test('into Company or another channel the label is "a private thread"; into P itself it is the first prompt', async () => {
    expect(await threadLabelOf(PROJECT, P_THREAD, null)).toBe('a private thread');
    expect(await threadLabelOf(PROJECT, P_THREAD, PUBLIC_C)).toBe('a private thread');
    expect(await threadLabelOf(PROJECT, P_THREAD, P)).toContain(WORD);
  });

  test('POST notes to Company with a P thread as source writes no word of it', async () => {
    const res = await req('POST', '/memory/layers/company/notes', keys.alice!, { text: 'Remember the call', source_session_id: P_THREAD });
    expect(res.status).toBe(201);
    const notes = [...volume.files.entries()].find(([path]) => path.startsWith('/Company/Memory/') && path.endsWith('Notes.md'));
    expect(notes?.[1].text).toContain('(from a private thread)');
    expect(notes?.[1].text).not.toContain(WORD);
  });
});

describe('links of a private channel', () => {
  test('a message link from a non-member is never collected; a member’s is', async () => {
    const send = (userId: string, url: string) =>
      collectMessageLinks({ projectId: PROJECT, sessionId: P_THREAD, spaceId: P, visibility: 'project', userId, text: `see ${url}` });
    await send(BOB, 'https://bob.example.test/x');
    await send(ALICE, 'https://alice.example.test/y');
    const urls = (await db.select({ url: projectSpaceLinks.url }).from(projectSpaceLinks).where(eq(projectSpaceLinks.spaceId, P))).map((r) => r.url);
    expect(urls).toEqual(['https://alice.example.test/y']);
  });

  test('the unfurl cache never lends a title across a private boundary', async () => {
    const url = `https://unfurl-${P.slice(0, 6)}.invalid/doc`;
    const fresh = new Date();
    const [fromP] = await db
      .insert(projectSpaceLinks)
      .values({ projectId: PROJECT, spaceId: P, url, createdBy: ALICE, pinned: false, fetchedTitle: 'Secret deal room', fetchedAt: fresh })
      .returning();
    const [inPublic] = await db
      .insert(projectSpaceLinks)
      .values({ projectId: PROJECT, spaceId: PUBLIC_C, url, createdBy: BOB, pinned: false })
      .returning();
    await unfurlLink(inPublic!.linkId);
    const [after] = await db.select().from(projectSpaceLinks).where(eq(projectSpaceLinks.linkId, inPublic!.linkId));
    expect(after!.fetchedTitle).toBeNull();
    // The other way: a public title stays out of the private channel too.
    const url2 = `https://unfurl2-${P.slice(0, 6)}.invalid/doc`;
    await db.insert(projectSpaceLinks).values({ projectId: PROJECT, spaceId: PUBLIC_C, url: url2, createdBy: BOB, pinned: false, fetchedTitle: 'Public', fetchedAt: fresh });
    const [inP] = await db.insert(projectSpaceLinks).values({ projectId: PROJECT, spaceId: P, url: url2, createdBy: ALICE, pinned: false }).returning();
    await unfurlLink(inP!.linkId);
    expect((await db.select().from(projectSpaceLinks).where(eq(projectSpaceLinks.linkId, inP!.linkId)))[0]!.fetchedTitle).toBeNull();
    // Within the public side the cache still lends.
    const [general2] = await db.insert(projectSpaceLinks).values({ projectId: PROJECT, spaceId: general, url: url2, createdBy: BOB, pinned: false }).returning();
    await unfurlLink(general2!.linkId);
    expect((await db.select().from(projectSpaceLinks).where(eq(projectSpaceLinks.linkId, general2!.linkId)))[0]!.fetchedTitle).toBe('Public');
    expect(fromP!.fetchedTitle).toBe('Secret deal room');
  });
});

describe('triggers from the project config never run in a private channel', () => {
  test('pointing a trigger at P → 400 private_channel_trigger, on create and on PATCH, for a member too', async () => {
    const caller = { userId: ALICE, bound: null, row: { accountId: ACCOUNT, metadata } };
    const created = await resolveTriggerSpaceCreate(PROJECT, caller, { space_id: P }, 'kortix');
    expect('error' in created && created.error).toMatchObject({ status: 400, body: { code: 'private_channel_trigger' } });
    const patched = await resolveTriggerSpacePatch(PROJECT, 'any', caller, { space_id: P });
    expect('error' in patched && patched.error).toMatchObject({ status: 400, body: { code: 'private_channel_trigger' } });
    // A public channel is still fine.
    expect('space' in (await resolveTriggerSpaceCreate(PROJECT, caller, { space_id: PUBLIC_C }, 'kortix'))).toBe(true);
  });

  test('a trigger already stored on P (set before a conversion) fails its fire with private_channel_trigger, starting nothing', async () => {
    await db.insert(projectTriggerRuntime).values({ projectId: PROJECT, slug: 'stored-in-p', spaceId: P });
    const before = await db.select({ id: projectSessions.sessionId }).from(projectSessions).where(eq(projectSessions.projectId, PROJECT));
    const result = await fireGitTrigger({
      spec: { slug: 'stored-in-p', name: 'stored-in-p', agent: 'kortix', type: 'cron', sessionMode: 'new' } as never,
      project: { projectId: PROJECT, accountId: ACCOUNT, metadata } as never,
      payload: {},
      renderedPrompt: 'copy #deals into Company',
      source: 'manual' as never,
      deliberate: true,
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'private_channel_trigger', retryable: false });
    const after = await db.select({ id: projectSessions.sessionId }).from(projectSessions).where(eq(projectSessions.projectId, PROJECT));
    expect(after.length).toBe(before.length);
  });

  test('a reminder in a P thread acts as its author while they are a member; else it does not run', async () => {
    await db.insert(projectTriggerRuntime).values([
      { projectId: PROJECT, slug: 'owner-in', ownerUserId: ALICE, spaceId: P },
      { projectId: PROJECT, slug: 'owner-out', ownerUserId: BOB, spaceId: P },
      { projectId: PROJECT, slug: 'no-owner', spaceId: P },
    ]);
    expect(await privateChannelRunActor(project, 'owner-in', P, OWNER)).toBe(ALICE);
    expect(await privateChannelRunActor(project, 'owner-out', P, OWNER)).toBeNull();
    expect(await privateChannelRunActor(project, 'no-owner', P, OWNER)).toBeNull();
    expect(await privateChannelRunActor(project, 'owner-out', P, CAROL)).toBe(CAROL);
    expect(await privateChannelRunActor(project, 'owner-out', general, OWNER)).toBe(OWNER);
    expect(await privateChannelRunActor(project, 'owner-out', null, OWNER)).toBe(OWNER);
  });
});

describe('artifacts follow the one Drive rule', () => {
  const viewerOf = async (userId: string, bound: string | null = null) => {
    const folders = await privateChannelFoldersFor(PROJECT, userId, bound);
    return {
      userId,
      projectWrite: false,
      manageAny: false,
      privateFolders: folders.visible,
      allPrivateFolders: folders.all,
      channelFolder: bound ? await sessionPrivateChannelFolder(bound) : null,
    };
  };
  const scope = { accountId: ACCOUNT, projectId: PROJECT };
  let artifactId = '';

  test('N1 attack: a member’s #general token shares a P file → 404, nothing shared', async () => {
    const viewer = await viewerOf(ALICE, GENERAL_THREAD);
    await expect(share(scope, { userId: ALICE, sessionId: GENERAL_THREAD }, viewer, { path: `${FOLDER}/deck`, visibility: 'project' }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('N1 attack: a non-member with a stale grant on the folder shares it → 404', async () => {
    const drive = (await ensureProjectDrive(ACCOUNT, PROJECT))!;
    await setFolderGrant({ drive, path: FOLDER, principal: { type: 'user', id: BOB }, level: 'write', grantedBy: null, source: 'system' });
    await expect(share(scope, { userId: BOB, sessionId: null }, await viewerOf(BOB), { path: `${FOLDER}/deck` })).rejects.toMatchObject({ status: 404 });
    await afterPrivateChannelChange(PROJECT, { enforce: false });
  });

  test('N1 attack: P’s own thread token or a member makes a P artifact project-wide → 403 private_channel', async () => {
    for (const viewer of [await viewerOf(ALICE, P_THREAD), await viewerOf(ALICE)]) {
      await expect(share(scope, { userId: ALICE, sessionId: null }, viewer, { path: `${FOLDER}/deck`, visibility: 'project' }))
        .rejects.toMatchObject({ status: 403, code: 'private_channel' });
    }
  });

  test('a member shares it privately; a non-member never views or lists it, even when named in its sharing', async () => {
    const row = await share(scope, { userId: ALICE, sessionId: null }, await viewerOf(ALICE), { path: `${FOLDER}/deck` });
    artifactId = row.artifactId;
    const named = await updateArtifactMeta(row, { shared_with_user_ids: [BOB, CAROL] });
    expect(canView(named, await viewerOf(BOB))).toBe(false);
    expect(canView(named, await viewerOf(MANAGER))).toBe(false);
    expect(canView(named, await viewerOf(CAROL))).toBe(true);
    expect((await listArtifacts(PROJECT, await viewerOf(BOB), { scope: 'all', limit: 50 })).map((a) => a.artifactId)).not.toContain(artifactId);
    expect((await listArtifacts(PROJECT, await viewerOf(CAROL), { scope: 'all', limit: 50 })).map((a) => a.artifactId)).toContain(artifactId);
    await expect(updateArtifactMeta(named, { visibility: 'public' })).rejects.toMatchObject({ status: 403, code: 'private_channel' });
  });
});

describe('a private folder is named by its channel id', () => {
  test('a rename moves nothing, and a new private channel that takes the old name gets its own folder', async () => {
    moves.length = 0;
    const viewer = { userId: ALICE, manager: false, access: await spaceAccessFor(PROJECT, ALICE, null) };
    const renamed = await updateChannel(PROJECT, viewer, P, { name: `q4-${P.slice(0, 6)}` });
    expect('space' in renamed && renamed.space.slug).toBe(`q4-${P.slice(0, 6)}`);
    const res = await req('PATCH', `/spaces/${P}`, keys.alice!, { name: SLUG });
    expect(res.status).toBe(200);
    expect(moves).toEqual([]);
    const other = crypto.randomUUID();
    expect(spaceDriveFolders('channel', SLUG, null, other)!.files).toBe(`/Channels/${other}`);
    expect(spaceDriveFolders('channel', SLUG, null, other)!.files).not.toBe(FOLDER);
  });
});

describe('conversion moves the folder', () => {
  const viewer = async () => ({ userId: ALICE, manager: false, access: await spaceAccessFor(PROJECT, ALICE, null) });

  test('a storage failure refuses the conversion: the channel stays public', async () => {
    moveFails = true;
    try {
      const result = await updateChannel(PROJECT, await viewer(), CONV, { visibility: 'private' });
      expect(result).toMatchObject({ error: { status: 503, body: { code: 'folder_move_failed' } } });
    } finally {
      moveFails = false;
    }
    const [row] = await db.select().from(projectSpaces).where(eq(projectSpaces.spaceId, CONV));
    expect(row!.visibility).toBe('public');
  });

  test('the folder moves from /Company/Channels to /Channels and the members get its grants', async () => {
    moves.length = 0;
    const result = await updateChannel(PROJECT, await viewer(), CONV, { visibility: 'private' });
    expect('space' in result && result.converted).toBe(true);
    expect(moves).toEqual([`/Company/Channels/${CONV_SLUG} -> /Channels/${CONV}`]);
    await afterPrivateChannelChange(PROJECT, { enforce: true });
    const grants = (await listFolderGrants((await ensureProjectDrive(ACCOUNT, PROJECT))!)).filter((g) => g.path === `/Channels/${CONV}`);
    // The creator and the thread starter (bob) became members.
    expect(grants.map((g) => g.principalId).sort()).toEqual([ALICE, BOB].sort());
  });
});

describe('a removed member', () => {
  test('leaving ends the grant and every stale mount of the folder; the channel’s own thread keeps its mount', async () => {
    const stale = { driveId, kind: 'project', mountPath: `/drives/${SLUG}`, readOnly: false, subdir: FOLDER, role: 'drive' };
    const company = { driveId, kind: 'project', mountPath: '/drives/company', readOnly: false, subdir: '/Company', role: 'drive' };
    await setBox(generalBox, 'stopped', [company, stale]);
    await setBox(pBox, 'stopped', [company, stale]);
    detached.length = 0;
    // The creator removes carol.
    const res = await req('DELETE', `/spaces/${P}/members/${CAROL}`, keys.alice!);
    expect(res.status).toBe(200);
    const drive = (await ensureProjectDrive(ACCOUNT, PROJECT))!;
    expect((await listFolderGrants(drive)).some((g) => g.principalId === CAROL)).toBe(false);
    expect(await accessAt(CAROL, `${FOLDER}/Memory/plan.md`)).toBe('none');
    const mountsOf = async (sandboxId: string) =>
      recordedDriveMounts((await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId)))[0]!.metadata).map((m) => m.subdir);
    expect(await mountsOf(generalBox.sandboxId)).toEqual(['/Company']);
    expect(detached).toContain(`${generalBox.externalId} /drives/${SLUG}`);
    // P's own box keeps its folder; its read-write /Company mount ends (read-only there, remounted so on the next boot).
    expect(await mountsOf(pBox.sandboxId)).toEqual([FOLDER]);
  });
});

describe('a Drive restore never crosses a private channel', () => {
  test('N4 attack: a project admin outside P restores Files → 403; an admin in every private channel restoring to before a private channel’s last change → 409; after it → 204', async () => {
    await db.update(drives).set({ platinumVolumeId: 'vol' }).where(eq(drives.driveId, driveId));
    commits.length = 0;
    commits.push(
      { id: 'v-new', kind: 'api', created_at: new Date(Date.now() + 11 * 60_000).toISOString(), author: null },
      // a version stamped just after the floor by the storage clock may predate it on the API clock.
      { id: 'v-near', kind: 'api', created_at: new Date(Date.now() + 60_000).toISOString(), author: null },
      { id: 'v-old', kind: 'api', created_at: '2020-01-01T00:00:00.000Z', author: null },
    );
    restored.length = 0;
    const restore = (secret: string, versionId: string) => req('POST', `/v1/drives/${driveId}/restore`, secret, { versionId });
    const outside = await restore(keys.manager!, 'v-new');
    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe('restore_crosses_private_channel');
    // The account owner joins every private channel of the project, then restores.
    const privateIds = (await db.select({ id: projectSpaces.spaceId }).from(projectSpaces).where(and(eq(projectSpaces.projectId, PROJECT), eq(projectSpaces.visibility, 'private')))).map((r) => r.id);
    await db.insert(projectSpaceMembers).values(privateIds.map((spaceId) => ({ spaceId, userId: OWNER, addedBy: OWNER }))).onConflictDoNothing();
    await afterPrivateChannelChange(PROJECT, { enforce: false });
    keys.owner = await mint(OWNER);
    const old = await restore(keys.owner, 'v-old');
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('restore_crosses_private_channel');
    const near = await restore(keys.owner, 'v-near');
    expect(near.status).toBe(409);
    expect(restored).toEqual([]);
    expect((await restore(keys.owner, 'v-new')).status).toBe(204);
    expect(restored).toEqual(['v-new']);
  });
});


describe('a private channel thread writes only its channel folder, through every API', () => {
  test('the Drive rule caps a P thread token at read outside the channel folder', async () => {
    const own = (await listFolderGrants((await ensureProjectDrive(ACCOUNT, PROJECT))!)).find((g) => g.principalId === ALICE && g.path.startsWith('/Users/'))!.path;
    for (const bound of [P_THREAD, P_PRIVATE_THREAD]) {
      expect(await accessAt(ALICE, '/Company/x.md', { bound })).toBe('read');
      expect(await accessAt(ALICE, `${own}/x.md`, { bound })).toBe('read');
      expect(await accessAt(ALICE, `${FOLDER}/x.md`, { bound })).toBe('write');
    }
    // The same person outside a P thread still writes Company.
    expect(await accessAt(ALICE, '/Company/x.md')).toBe('write');
  });

  test('R1a attack: `kortix drive put /Company/...` from a private-visibility P thread → 403, nothing written', async () => {
    const own = (await listFolderGrants((await ensureProjectDrive(ACCOUNT, PROJECT))!)).find((g) => g.principalId === ALICE && g.path.startsWith('/Users/'))!.path;
    written.length = 0;
    const put = (path: string) =>
      app.request(`/v1/drives/${driveId}/files/content?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${keys.pPrivate}` },
        body: 'the deal terms',
      });
    expect((await put('/Company/report.md')).status).toBe(403);
    expect((await put(`${own}/report.md`)).status).toBe(403);
    expect(written).toEqual([]);
    expect((await put(`${FOLDER}/report.md`)).status).toBe(200);
    expect(written).toEqual([`${FOLDER}/report.md`]);
  });

  test('R1b attack: a P thread token publishes an artifact project-wide → 403; privately it lands in the channel folder', async () => {
    written.length = 0;
    const publish = (visibility: string) =>
      req('POST', '/artifacts', keys.pPrivate!, { title: 'Deal memo', visibility, files: { 'index.md': { content: '# Deal memo' } } });
    const wide = await publish('project');
    expect(wide.status).toBe(403);
    expect(wide.body.code).toBe('private_channel');
    expect(written).toEqual([]);
    const mine = await publish('private');
    expect(mine.status).toBe(201);
    expect(mine.body.path.startsWith(`${FOLDER}/Artifacts/`)).toBe(true);
    expect(written.every((path) => path.startsWith(`${FOLDER}/`))).toBe(true);
  });

  test('R1b attack: a P thread token overwrites or restores an artifact in /Company → 403, nothing written', async () => {
    const [row] = await db
      .insert(artifactsTable)
      .values({ projectId: PROJECT, accountId: ACCOUNT, driveId, root: '/Company/deck', entry: 'index.md', folder: true, title: 'Deck', type: 'doc', visibility: 'project', createdByUserId: ALICE })
      .returning();
    written.length = 0;
    const save = await req('PUT', `/artifacts/${row!.artifactId}`, keys.pPrivate!, { files: { 'index.md': { content: '# leaked' } } });
    expect(save.status).toBe(403);
    expect(written).toEqual([]);
    // Alice herself, outside the thread, still saves it.
    expect((await req('PUT', `/artifacts/${row!.artifactId}`, keys.alice!, { files: { 'index.md': { content: '# mine' } } })).status).toBe(200);
  });
});
