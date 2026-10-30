/**
 * Integration test (real local DB, fake Drive volume): who may open which
 * memory layer (Drive folder rights, DMs private to their owner), the file
 * list a turn carries (`system`, at the thread's mount paths), the "Used
 * memory" record written once per thread, and search over files.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accounts, memoryThreadLoads, projectSessions, projectSpaces, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { ensurePersonalFolder, ensureProjectDrive } from '../drives/service';
import { pageIdOf } from '../memory/files';
import { resolveLayer, type Viewer } from '../memory/layers';
import { searchMemory } from '../memory/search';
import { recordThreadLoad, threadUsage } from '../memory/thread-loads';
import { memoryTurnContext } from '../memory/turn-context';
import { setVolumeOpsForTests } from '../memory/volume-ops';
import { db } from '../shared/db';
import { FakeVolume } from './helpers/memory-fake-volume';
import * as registry from '../feature-flags/registry';

// This lane has no Platinum key, so `drives` is never available here; the fake volume stands in for it.
const resolveFeatureFlag = registry.resolveFeatureFlag;
mock.module('../feature-flags/registry', () => ({
  ...registry,
  resolveFeatureFlag: (metadata: unknown, key: string) =>
    key === 'drives' ? Boolean((metadata as { experimental?: { drives?: boolean } } | null)?.experimental?.drives) : resolveFeatureFlag(metadata, key as never),
}));

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
const project = { projectId: PROJECT, accountId: ACCOUNT, metadata: { experimental: { project_channels: true, drives: true } } };
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
        { driveId: drive.driveId, kind: 'project', mountPath: '/drives/company', readOnly: false, subdir: '/Company', role: 'drive' },
        { driveId: drive.driveId, kind: 'project', mountPath: '/drives/me', readOnly: false, subdir: priyaFolder, role: 'me' },
      ],
    },
  });
  // Files already in Drive before Channels: read in place, nothing copied.
  volume.put('/Company/Memory/launch-plan.md', '# Launch plan\n\nShip on 2026-11-02, pricing at $49.\n');
  // The folder index agents keep: never a page, never listed to a turn, never a search hit.
  volume.put('/Company/Memory/MEMORY.md', '- [Launch plan](launch-plan.md) — pricing dates\n');
  volume.put('/Company/Channels/marketing/Memory/decisions/pricing.md', '# Pricing\n\nStays at $49 per seat.\n');
  volume.put('/Company/Channels/old/Memory/old-pricing.md', '# Old pricing\n');
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

  test('Company and channels: every member writes, an archived channel is read-only, a caller outside the project gets 404', async () => {
    expect(await resolveLayer(project, 'company', person(SAM))).toMatchObject({ root: '/Company/Memory', canWrite: true });
    expect(await resolveLayer(project, OLD, person(SAM))).toMatchObject({ readOnly: true, canWrite: false });
    await expect(resolveLayer(project, 'company', person(OUTSIDER, false, false))).rejects.toMatchObject({ status: 404 });
    await expect(resolveLayer(project, 'not-a-key', person(SAM))).rejects.toMatchObject({ status: 404 });
  });

  test('Drive off: 403 feature_disabled', async () => {
    const off = { ...project, metadata: { experimental: { project_channels: true, drives: false } } };
    await expect(resolveLayer(off, 'company', person(SAM))).rejects.toMatchObject({ status: 403, code: 'feature_disabled' });
  });
});

describe('the turn list and "Used memory"', () => {
  test('a private channel thread lists Company, the channel and the owner’s DM at their mount paths', async () => {
    const turn = (await memoryTurnContext(PROJECT, PRIVATE_THREAD, PRIYA))!;
    expect(turn.firstTurn).toBe(true);
    expect(turn.system).toContain('### Company: /drives/company/Memory/\n- launch plan (launch-plan.md)');
    expect(turn.system).toContain('### #marketing: /drives/company/Channels/marketing/Memory/\n- pricing (decisions/pricing.md)');
    expect(turn.system).toContain('### Your memory with writer: /drives/me/Memory/ (save here only from the DM)\n- tone (writer/tone.md)');
    expect(turn.system).not.toContain('researcher/');
    expect(turn.system).not.toContain('MEMORY.md');
    // Another prompter (a manager) never gets the owner's DM.
    expect((await memoryTurnContext(PROJECT, PRIVATE_THREAD, SAM))!.system).not.toContain('Your memory with');
  });

  test('a thread with no recorded mounts is told the folders are not mounted', async () => {
    const turn = (await memoryTurnContext(PROJECT, THREAD, PRIYA))!;
    expect(turn.system).toContain('### Company: not mounted in this thread');
    expect(turn.loaded.every((layer) => layer.page_ids.length === 0)).toBe(true);
  });

  test('the first turn is recorded once; usage drops files deleted since and hides the DM from others', async () => {
    expect(await threadUsage(PRIVATE_THREAD, PRIYA)).toEqual({ loaded_at: null, layers: [] });
    const first = (await memoryTurnContext(PROJECT, PRIVATE_THREAD, PRIYA))!;
    await recordThreadLoad(PRIVATE_THREAD, first.loaded);
    await recordThreadLoad(PRIVATE_THREAD, []);
    expect((await db.select().from(memoryThreadLoads).where(eq(memoryThreadLoads.sessionId, PRIVATE_THREAD)))[0]!.layers).toHaveLength(3);
    expect((await memoryTurnContext(PROJECT, PRIVATE_THREAD, PRIYA))!.firstTurn).toBe(false);
    const owner = await threadUsage(PRIVATE_THREAD, PRIYA);
    expect(owner.layers.map((layer) => [layer.layer_key, layer.pages.map((p) => [p.page_id, p.type])])).toEqual([
      ['company', [[pageIdOf('company', 'launch-plan.md'), 'other']]],
      [MARKETING, [[pageIdOf(MARKETING, 'decisions/pricing.md'), 'decisions']]],
      [PRIYA_DM, [[pageIdOf(PRIYA_DM, 'writer/tone.md'), 'other']]],
    ]);
    expect((await threadUsage(PRIVATE_THREAD, SAM)).layers.map((layer) => layer.scope)).toEqual(['company', 'channel']);
    volume.files.delete('/Company/Memory/launch-plan.md');
    try {
      expect((await threadUsage(PRIVATE_THREAD, PRIYA)).layers.map((layer) => layer.scope)).toEqual(['channel', 'dm']);
    } finally {
      volume.put('/Company/Memory/launch-plan.md', '# Launch plan\n\nShip on 2026-11-02, pricing at $49.\n');
    }
  });
});

describe('search over files', () => {
  const titles = (result: { hits: { title: string }[] }) => result.hits.map((hit) => hit.title).sort();

  test('a person searches Company, live channels and their own Memory folder; never another member’s', async () => {
    const priya = await searchMemory(project, person(PRIYA), { q: 'pricing', limit: 20 });
    expect(titles(priya)).toEqual(['Launch plan', 'Pricing', 'Tone']);
    expect(priya.hits.find((hit) => hit.title === 'Tone')).toMatchObject({ layer_key: PRIYA_DM, scope: 'dm', layer_name: 'writer' });
    expect(priya.hits[0]!.title).toBe('Pricing'); // a title hit ranks first
    expect(titles(await searchMemory(project, person(SAM), { q: 'pricing', limit: 20 }))).toEqual(['Launch plan', 'Pricing']);
  });

  test('an archived channel only when named; another member’s DM by name is 404; type and limit narrow', async () => {
    expect(titles(await searchMemory(project, person(SAM), { q: 'pricing', layer: OLD, limit: 20 }))).toEqual(['Old pricing']);
    await expect(searchMemory(project, person(SAM), { q: 'pricing', layer: PRIYA_DM, limit: 20 })).rejects.toMatchObject({ status: 404 });
    expect(titles(await searchMemory(project, person(PRIYA), { q: 'pricing', type: 'decisions', limit: 20 }))).toEqual(['Pricing']);
    expect((await searchMemory(project, person(PRIYA), { q: 'pricing', limit: 1 })).hits).toHaveLength(1);
  });
});
