/**
 * Integration test (real local DB, fake Drive volume): who may open which
 * memory layer (Drive folder rights, DMs private to their owner), the file
 * list a turn carries (`system`, at the thread's mount paths), the "Used
 * memory" record written once per thread, and search over files.
 *
 * Drive is agent-first: there is no project-wide Company layer, and a public
 * channel's folder is granted to nobody (project admins reach it by role).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, memoryThreadLoads, projectSessions, projectSpaces, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { ensurePersonalFolder, ensureProjectDrive } from '../drives/service';
import { pageIdOf } from '../memory/files';
import { resolveLayer, type Viewer } from '../memory/layers';
import { searchMemory } from '../memory/search';
import { recordThreadLoad, threadUsage } from '../memory/thread-loads';
import { memoryTurnContext } from '../memory/turn-context';
import { setVolumeOpsForTests } from '../memory/volume-ops';
import { config } from '../config';
import { db } from '../shared/db';
import { FakeVolume } from './helpers/memory-fake-volume';

// This lane has no Platinum key; the fake volume stands in for the Drive, which needs one.
(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const SAM = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
const MARKETING = crypto.randomUUID();
const OLD = crypto.randomUUID();
const PRIYA_DM = crypto.randomUUID();
const PRIYA_DM2 = crypto.randomUUID();
const THREAD = crypto.randomUUID();
const PRIVATE_THREAD = crypto.randomUUID();
const project = { projectId: PROJECT, accountId: ACCOUNT, metadata: { experimental: { chat: true, drives: true } } };
/** A project member; `admin` may change the project. */
const person = (userId: string, admin = false, member = true): Viewer => ({ userId, may: async (action) => (action === 'write' ? admin : member) });
const volume = new FakeVolume();
let priyaFolder = '';

beforeAll(async () => {
  setVolumeOpsForTests(volume);
  // Folder grants name known users: every viewer here gets their own folder on first use.
  const user = (id: string) => sql`(${id}::uuid, ${`memory-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES ${sql.join([PRIYA, SAM, OUTSIDER].map(user), sql`, `)}`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'memory-files' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'memory-files', repoUrl: 'https://example.test/m.git', metadata: project.metadata });
  await db.insert(projectSpaces).values([
    { spaceId: MARKETING, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'marketing', name: 'marketing' },
    { spaceId: OLD, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'old', name: 'old', archivedAt: new Date() },
    { spaceId: PRIYA_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'writer', dmUserId: PRIYA, dmAgentName: 'writer' },
    { spaceId: PRIYA_DM2, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'researcher', dmUserId: PRIYA, dmAgentName: 'researcher' },
  ]);
  await db.insert(projectSessions).values([
    { sessionId: THREAD, accountId: ACCOUNT, projectId: PROJECT, branchName: 't', createdBy: PRIYA, agentName: 'writer', spaceId: MARKETING, visibility: 'project' },
    { sessionId: PRIVATE_THREAD, accountId: ACCOUNT, projectId: PROJECT, branchName: 'p', createdBy: PRIYA, agentName: 'writer', spaceId: MARKETING, visibility: 'private' },
  ]);
  const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
  priyaFolder = await ensurePersonalFolder(drive, PRIYA);
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId: PRIVATE_THREAD,
    accountId: ACCOUNT,
    projectId: PROJECT,
    externalId: 'sandbox-memory-files',
    status: 'active',
    metadata: {
      driveMounts: [
        // The writer agent's own Drive, the channel folder an admin granted to the agent, and Priya's folder.
        { driveId: drive.driveId, kind: 'project', mountPath: '/drives/writer', readOnly: false, subdir: '/Agents/writer', role: 'drive' },
        { driveId: drive.driveId, kind: 'project', mountPath: '/drives/marketing', readOnly: false, subdir: '/Company/Channels/marketing', role: 'drive' },
        { driveId: drive.driveId, kind: 'project', mountPath: '/drives/me', readOnly: false, subdir: priyaFolder, role: 'me' },
      ],
    },
  });
  // Left over from the old project-wide Company layer: no thread, list or search reads it any more.
  volume.put('/Company/Memory/launch-plan.md', '# Launch plan\n\nShip on 2026-11-02, pricing at $49.\n');
  // The folder index agents keep: never a page, never listed to a turn, never a search hit.
  volume.put('/Company/Memory/MEMORY.md', '- [Launch plan](launch-plan.md) — pricing dates\n');
  volume.put('/Company/Channels/marketing/Memory/decisions/pricing.md', '# Pricing\n\nStays at $49 per seat.\n');
  volume.put('/Company/Channels/old/Memory/old-pricing.md', '# Old pricing\n');
  volume.put('/Company/Channels/old/Memory/archive.md', '# Archive\n\nOld pricing notes.\n');
  volume.put(`${priyaFolder}/Memory/writer/tone.md`, '# Tone\n\nPlain words; pricing in euros.\n');
  volume.put(`${priyaFolder}/Memory/researcher/sources.md`, '# Sources\n');
});

afterAll(async () => {
  setVolumeOpsForTests(null);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`DELETE FROM auth.users WHERE id = ANY(${`{${[PRIYA, SAM, OUTSIDER].join(',')}}`}::uuid[])`);
});

describe('who opens a layer', () => {
  test('the DM owner opens it: their Memory folder, the agent folder first, another agent’s folder left out', async () => {
    const layer = await resolveLayer(project, PRIYA_DM, person(PRIYA));
    expect(layer).toMatchObject({ scope: 'dm', root: `${priyaFolder}/Memory`, agentFolder: `${priyaFolder}/Memory/writer`, skip: [`${priyaFolder}/Memory/researcher`], canWrite: true });
  });

  test('another member, and a project admin, get 404 on someone’s DM', async () => {
    await expect(resolveLayer(project, PRIYA_DM, person(SAM))).rejects.toMatchObject({ status: 404, code: 'memory_not_found' });
    await expect(resolveLayer(project, PRIYA_DM, person(SAM, true))).rejects.toMatchObject({ status: 404, code: 'memory_not_found' });
  });

  test('no Company layer for anyone; a public channel is admins-only, archived read-only; outside the project 404', async () => {
    // The project-wide layer is gone: a member and an admin both get 404.
    await expect(resolveLayer(project, 'company', person(SAM))).rejects.toMatchObject({ status: 404, code: 'memory_not_found' });
    await expect(resolveLayer(project, 'company', person(SAM, true))).rejects.toMatchObject({ status: 404, code: 'memory_not_found' });
    // Nothing grants a public channel's folder: a member gets 404, an admin manages it by role.
    await expect(resolveLayer(project, MARKETING, person(SAM))).rejects.toMatchObject({ status: 404, code: 'memory_not_found' });
    expect(await resolveLayer(project, MARKETING, person(SAM, true))).toMatchObject({ root: '/Company/Channels/marketing/Memory', canWrite: true });
    expect(await resolveLayer(project, OLD, person(SAM, true))).toMatchObject({ readOnly: true, canWrite: false });
    await expect(resolveLayer(project, MARKETING, person(OUTSIDER, false, false))).rejects.toMatchObject({ status: 404 });
    await expect(resolveLayer(project, 'not-a-key', person(SAM))).rejects.toMatchObject({ status: 404 });
  });

  test('no Drive storage (no Platinum): 403 feature_disabled', async () => {
    const key = config.PLATINUM_API_KEY;
    (config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY = '';
    try {
      await expect(resolveLayer(project, PRIYA_DM, person(PRIYA))).rejects.toMatchObject({ status: 403, code: 'feature_disabled' });
    } finally {
      (config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY = key;
    }
  });
});

describe('the turn list and "Used memory"', () => {
  test('a private channel thread lists the channel and the owner’s DM at their mount paths, no Company layer', async () => {
    const turn = (await memoryTurnContext(PROJECT, PRIVATE_THREAD, PRIYA))!;
    expect(turn.firstTurn).toBe(true);
    expect(turn.system).not.toContain('### Company');
    expect(turn.system).not.toContain('launch-plan.md');
    expect(turn.system).toContain('### #marketing: /drives/marketing/Memory/\n- pricing (decisions/pricing.md)');
    expect(turn.system).toContain('### Your memory with writer: /drives/me/Memory/ (save here only from the DM)\n- tone (writer/tone.md)');
    expect(turn.system).not.toContain('researcher/');
    expect(turn.system).not.toContain('MEMORY.md');
    // Another prompter (a manager) never gets the owner's DM.
    expect((await memoryTurnContext(PROJECT, PRIVATE_THREAD, SAM))!.system).not.toContain('Your memory with');
  });

  test('a thread with no recorded mounts is told the folders are not mounted', async () => {
    const turn = (await memoryTurnContext(PROJECT, THREAD, PRIYA))!;
    expect(turn.system).toContain('### #marketing: not mounted in this thread');
    expect(turn.system).not.toContain('### Company');
    expect(turn.loaded.every((layer) => layer.page_ids.length === 0)).toBe(true);
  });

  test('the first turn is recorded once; usage drops files deleted since and hides the DM from others', async () => {
    expect(await threadUsage(PRIVATE_THREAD, PRIYA)).toEqual({ loaded_at: null, layers: [] });
    const first = (await memoryTurnContext(PROJECT, PRIVATE_THREAD, PRIYA))!;
    await recordThreadLoad(PRIVATE_THREAD, first.loaded);
    await recordThreadLoad(PRIVATE_THREAD, []);
    expect((await db.select().from(memoryThreadLoads).where(eq(memoryThreadLoads.sessionId, PRIVATE_THREAD)))[0]!.layers).toHaveLength(2);
    expect((await memoryTurnContext(PROJECT, PRIVATE_THREAD, PRIYA))!.firstTurn).toBe(false);
    const owner = await threadUsage(PRIVATE_THREAD, PRIYA);
    expect(owner.layers.map((layer) => [layer.layer_key, layer.pages.map((p) => [p.page_id, p.type])])).toEqual([
      [MARKETING, [[pageIdOf(MARKETING, 'decisions/pricing.md'), 'decisions']]],
      [PRIYA_DM, [[pageIdOf(PRIYA_DM, 'writer/tone.md'), 'other']]],
    ]);
    expect((await threadUsage(PRIVATE_THREAD, SAM)).layers.map((layer) => layer.scope)).toEqual(['channel']);
    volume.files.delete('/Company/Channels/marketing/Memory/decisions/pricing.md');
    try {
      expect((await threadUsage(PRIVATE_THREAD, PRIYA)).layers.map((layer) => layer.scope)).toEqual(['dm']);
    } finally {
      volume.put('/Company/Channels/marketing/Memory/decisions/pricing.md', '# Pricing\n\nStays at $49 per seat.\n');
    }
  });
});

describe('search over files', () => {
  const titles = (result: { hits: { title: string }[] }) => result.hits.map((hit) => hit.title).sort();

  test('a member searches only their own Memory folder; an admin the live channels; never another member’s, never Company', async () => {
    const priya = await searchMemory(project, person(PRIYA), { q: 'pricing', limit: 20 });
    expect(titles(priya)).toEqual(['Tone']);
    expect(priya.hits.find((hit) => hit.title === 'Tone')).toMatchObject({ layer_key: PRIYA_DM, scope: 'dm', layer_name: 'writer' });
    expect(titles(await searchMemory(project, person(SAM), { q: 'pricing', limit: 20 }))).toEqual([]);
    expect(titles(await searchMemory(project, person(SAM, true), { q: 'pricing', limit: 20 }))).toEqual(['Pricing']);
  });

  test('an archived channel only when named, and only for an admin; another member’s DM by name is 404; type and limit narrow', async () => {
    const old = await searchMemory(project, person(SAM, true), { q: 'pricing', layer: OLD, limit: 20 });
    expect(titles(old)).toEqual(['Archive', 'Old pricing']);
    expect(old.hits[0]!.title).toBe('Old pricing'); // a title hit ranks first
    await expect(searchMemory(project, person(SAM), { q: 'pricing', layer: OLD, limit: 20 })).rejects.toMatchObject({ status: 404 });
    await expect(searchMemory(project, person(SAM, true), { q: 'pricing', layer: PRIYA_DM, limit: 20 })).rejects.toMatchObject({ status: 404 });
    expect(titles(await searchMemory(project, person(SAM, true), { q: 'pricing', type: 'decisions', limit: 20 }))).toEqual(['Pricing']);
    expect((await searchMemory(project, person(SAM, true), { q: 'pricing', layer: OLD, limit: 1 })).hits).toHaveLength(1);
  });
});
