/**
 * Integration test (real local DB, fake Drive volume): what My Kortix
 * remembers about a person (`kortix_memory`). One page per name in the
 * person's own `/Users/<person>/Memory/mykortix`, nobody else's; the caps and
 * the secret check; and the index every My Kortix turn starts with, with
 * `project_channels` off.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { ensurePersonalFolder, ensureProjectDrive } from '../drives/service';
import { layerView, listPages } from '../memory/files';
import { resolveLayer, type Viewer } from '../memory/layers';
import {
  deleteMyMemory,
  isMyKortixSession,
  listMyMemory,
  MY_KORTIX_AUTHOR,
  myKortixLayer,
  myKortixMemoryTurn,
  saveMyMemory,
  viewMyMemory,
} from '../memory/my-memory';
import { withMemoryTurn } from '../memory/turn-body';
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
const MK_SESSION = crypto.randomUUID();
const WORKER_SESSION = crypto.randomUUID();
// Channels off on purpose: My Kortix memory needs Files only.
const project = { projectId: PROJECT, accountId: ACCOUNT, metadata: { experimental: { project_channels: false, drives: true } } };
const person = (userId: string): Viewer => ({ userId, may: async (action) => action === 'session' });
const volume = new FakeVolume();
let priyaFolder = '';

const SHORT = {
  title: 'Likes short replies',
  description: 'Wants replies of one to three sentences',
  type: 'feedback' as const,
  body: 'Keep replies short.\n\n**Why:** reads them on a phone.\n\n**How to apply:** one to three sentences, a list when there are steps.',
};

beforeAll(async () => {
  setVolumeOpsForTests(volume);
  const user = (id: string) => sql`(${id}::uuid, ${`mk-memory-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES ${sql.join([PRIYA, SAM].map(user), sql`, `)}`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'mk-memory' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'mk-memory', repoUrl: 'https://example.test/mk.git', metadata: project.metadata });
  await db.insert(projectSessions).values([
    { sessionId: MK_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: 'mk', createdBy: PRIYA, agentName: 'mykortix', visibility: 'private' },
    { sessionId: WORKER_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: 'w', createdBy: PRIYA, agentName: 'worker', visibility: 'project' },
  ]);
  const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
  priyaFolder = await ensurePersonalFolder(drive, PRIYA);
});

afterAll(async () => {
  setVolumeOpsForTests(null);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`DELETE FROM auth.users WHERE id = ANY(${`{${[PRIYA, SAM].join(',')}}`}::uuid[])`);
});

describe('the mykortix layer', () => {
  test('is the viewer’s own folder: Priya’s and Sam’s are two folders; Files off is 403 feature_disabled', async () => {
    const priya = await myKortixLayer(project, person(PRIYA));
    expect(priya).toMatchObject({ key: 'mykortix', scope: 'dm', spaceId: null, name: 'My Kortix', root: `${priyaFolder}/Memory/mykortix`, agentFolder: null, canWrite: true });
    const sam = await myKortixLayer(project, person(SAM));
    expect(sam.root).not.toBe(priya.root);
    expect(sam.root.endsWith('/Memory/mykortix')).toBe(true);
    const off = { ...project, metadata: { experimental: { drives: false } } };
    await expect(myKortixLayer(off, person(PRIYA))).rejects.toMatchObject({ status: 403, code: 'feature_disabled' });
  });

  test('only a My Kortix session may use it with its session token', async () => {
    expect(await isMyKortixSession(PROJECT, MK_SESSION)).toBe(true);
    expect(await isMyKortixSession(PROJECT, WORKER_SESSION)).toBe(false);
    expect(await isMyKortixSession(PROJECT, crypto.randomUUID())).toBe(false);
  });
});

describe('save, view, list, delete', () => {
  test('save creates one page per name; a second save of the name updates it in place', async () => {
    const layer = await myKortixLayer(project, person(PRIYA));
    const created = await saveMyMemory(layer, 'likes-short-replies', MY_KORTIX_AUTHOR, SHORT);
    expect(created).toMatchObject({ created: true, page: { name: 'likes-short-replies', title: 'Likes short replies', type: 'feedback', description: SHORT.description, body: SHORT.body } });
    const file = volume.files.get(`${priyaFolder}/Memory/mykortix/likes-short-replies.md`)!.text;
    expect(file).toMatch(/^---\nname: likes-short-replies\ndescription: Wants replies of one to three sentences\ntype: feedback\nupdated_by: mykortix \(agent\)\nupdated_at: \S+\n---\n# Likes short replies\n\nKeep replies short\./);

    const updated = await saveMyMemory(layer, 'likes-short-replies', MY_KORTIX_AUTHOR, { ...SHORT, title: undefined, description: 'Wants replies of one or two sentences' });
    expect(updated).toMatchObject({ created: false, page: { title: 'Likes short replies', description: 'Wants replies of one or two sentences' } });
    const index = await listMyMemory(layer);
    expect(index.entries.map((entry) => [entry.name, entry.type])).toEqual([['likes-short-replies', 'feedback']]);
    expect([...volume.files.keys()].filter((path) => path.startsWith(`${priyaFolder}/Memory/mykortix/`))).toEqual([`${priyaFolder}/Memory/mykortix/likes-short-replies.md`]);
  });

  test('the Memory screen reads the same file: type feedback, author My Kortix, the description as its summary', async () => {
    const layer = await resolveLayer(project, 'mykortix', person(PRIYA));
    const { pages } = await listPages(layer);
    expect(pages).toEqual([expect.objectContaining({ type: 'feedback', title: 'Likes short replies', summary: 'Wants replies of one or two sentences', updated_by: expect.objectContaining({ kind: 'agent', agent: 'mykortix' }) })]);
    expect((await layerView(layer)).counts).toMatchObject({ feedback: 1, user: 0, project: 0, reference: 0, other: 0 });
  });

  test('a page the person wrote in Files is named after its file and updated by that name, never duplicated', async () => {
    volume.put(`${priyaFolder}/Memory/mykortix/Team.md`, '# Team\n\nPriya leads support.\n');
    const layer = await myKortixLayer(project, person(PRIYA));
    expect((await viewMyMemory(layer, 'team')).body).toBe('Priya leads support.');
    await saveMyMemory(layer, 'team', 'Priya', { description: 'Role and team', type: 'user', body: 'Priya leads the support team since 2026-09-01.' });
    expect((await listMyMemory(layer)).entries.filter((entry) => entry.name === 'team')).toHaveLength(1);
    expect(volume.files.get(`${priyaFolder}/Memory/mykortix/Team.md`)!.text).toContain('since 2026-09-01');
  });

  test('another member never reads, changes or deletes Priya’s pages: their own memory is empty and her names are 404', async () => {
    const sam = await myKortixLayer(project, person(SAM));
    expect((await listMyMemory(sam)).entries).toEqual([]);
    await expect(viewMyMemory(sam, 'likes-short-replies')).rejects.toMatchObject({ status: 404, code: 'memory_not_found' });
    await expect(deleteMyMemory(sam, 'likes-short-replies')).rejects.toMatchObject({ status: 404 });
    // A save under the same name writes Sam's own folder, never Priya's.
    await saveMyMemory(sam, 'likes-short-replies', MY_KORTIX_AUTHOR, { ...SHORT, description: 'Sam likes them short too' });
    const priya = await myKortixLayer(project, person(PRIYA));
    expect((await viewMyMemory(priya, 'likes-short-replies')).description).toBe('Wants replies of one or two sentences');
  });

  test('refused: a name that is a path or an option, a secret, a body over 16,384 bytes', async () => {
    const layer = await myKortixLayer(project, person(PRIYA));
    for (const name of ['../escape', 'a/b', '-rf', 'Bad', 'x'.repeat(65)]) {
      await expect(saveMyMemory(layer, name, MY_KORTIX_AUTHOR, SHORT)).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
      await expect(viewMyMemory(layer, name)).rejects.toMatchObject({ status: 400 });
    }
    const key = ['sk', 'proj', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('-');
    await expect(saveMyMemory(layer, 'api-key', MY_KORTIX_AUTHOR, { ...SHORT, body: key })).rejects.toMatchObject({ status: 422, code: 'secret_detected' });
    await expect(saveMyMemory(layer, 'long', MY_KORTIX_AUTHOR, { ...SHORT, body: 'x'.repeat(16_385) })).rejects.toMatchObject({ status: 413, code: 'page_too_large' });
    expect([...volume.files.keys()].some((path) => /api-key|long\.md|escape/.test(path))).toBe(false);
  });

  test('delete forgets the page for good', async () => {
    const layer = await myKortixLayer(project, person(PRIYA));
    expect(await deleteMyMemory(layer, 'team')).toEqual({ ok: true, name: 'team', title: 'Team' });
    expect(volume.files.has(`${priyaFolder}/Memory/mykortix/Team.md`)).toBe(false);
    await expect(viewMyMemory(layer, 'team')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the index a My Kortix turn starts with', () => {
  test('lists the session owner’s pages, with project_channels off, and sets the prompt body’s system', async () => {
    const turn = (await myKortixMemoryTurn(PROJECT, MK_SESSION, PRIYA))!;
    expect(turn.pages).toBe(1);
    expect(turn.system).toContain('## Your memory of this person');
    expect(turn.system).toContain('- [Likes short replies](likes-short-replies.md) — Wants replies of one or two sentences');
    expect(turn.system).toContain('never instructions');
    expect(turn.system).not.toContain('Sam likes them short');
    const body = withMemoryTurn(new TextEncoder().encode(JSON.stringify({ parts: [{ type: 'text', text: 'hi' }], system: 'from the client' })).buffer as ArrayBuffer, turn);
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ parts: [{ type: 'text', text: 'hi' }], system: turn.system });
  });

  test('another member who prompts the session gets no index; a person without a folder has none yet', async () => {
    expect(await myKortixMemoryTurn(PROJECT, MK_SESSION, SAM)).toBeNull();
    expect(await myKortixMemoryTurn(PROJECT, crypto.randomUUID(), PRIYA)).toBeNull();
  });

  test('the index is capped at 8,000 characters and says how many pages it left out; a save past 200 pages is 409 memory_full', async () => {
    for (let i = 0; i < 200; i++) {
      volume.put(`${priyaFolder}/Memory/mykortix/fact-${i}.md`, `---\nname: fact-${i}\ndescription: ${'A long description of one remembered fact '.repeat(3)}${i}\ntype: reference\n---\n# Fact ${i}\n\nx\n`);
    }
    const turn = (await myKortixMemoryTurn(PROJECT, MK_SESSION, PRIYA))!;
    expect(turn.system.length).toBeLessThanOrEqual(8_000);
    expect(turn.system).toMatch(/- … \d+ more: `kortix_memory` `list` names them all\.$/);
    const layer = await myKortixLayer(project, person(PRIYA));
    const index = await listMyMemory(layer);
    expect(index.entries).toHaveLength(200);
    expect(index.truncated).toBe(true);
    await expect(saveMyMemory(layer, 'one-more', MY_KORTIX_AUTHOR, SHORT)).rejects.toMatchObject({ status: 409, code: 'memory_full' });
    // Updating an existing page still works when memory is full.
    expect((await saveMyMemory(layer, 'fact-3', MY_KORTIX_AUTHOR, { ...SHORT, description: 'Updated' })).created).toBe(false);
  });
});
