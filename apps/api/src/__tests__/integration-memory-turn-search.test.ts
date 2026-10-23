/**
 * Integration test (real local DB): the memory page list a turn carries
 * (`system`), the "Used memory" record written once per thread, and the one
 * search: which layers each caller searches, confirmed-only for agents, the
 * title fallback with a literal `%`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, memoryLayers, memoryPages, projectSessions, projectSpaces, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { type Viewer } from '../memory/layers';
import { searchMemory } from '../memory/search';
import { recordThreadLoad, threadUsage } from '../memory/thread-loads';
import { memoryTurnContext } from '../memory/turn-context';
import { titleKey } from '../memory/limits';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const SAM = crypto.randomUUID();
const MARKETING = crypto.randomUUID();
const OLD = crypto.randomUUID();
const PRIYA_DM = crypto.randomUUID();
const SAM_DM = crypto.randomUUID();
const THREAD = crypto.randomUUID();
const PRIVATE_THREAD = crypto.randomUUID();
const L = { company: crypto.randomUUID(), marketing: crypto.randomUUID(), old: crypto.randomUUID(), priya: crypto.randomUUID(), sam: crypto.randomUUID() };
const project = { projectId: PROJECT, metadata: { experimental: { project_channels: true, drives: false } } };
const person = (userId: string): Viewer => ({ userId, sessionId: null, isManager: async () => false });
const agent = (sessionId: string): Viewer => ({ userId: PRIYA, sessionId, isManager: async () => false });
const pageIds: Record<string, string> = {};

async function page(layerId: string, title: string, over: Partial<typeof memoryPages.$inferInsert> = {}) {
  const [row] = await db
    .insert(memoryPages)
    .values({ layerId, projectId: PROJECT, type: 'decisions', title, titleKey: titleKey(title), summary: `About ${title}`, body: '', ...over })
    .returning({ pageId: memoryPages.pageId });
  pageIds[title] = row!.pageId;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'memory-turn-search' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'memory-turn-search', repoUrl: 'https://example.test/m.git', metadata: project.metadata });
  await db.insert(projectSpaces).values([
    { spaceId: MARKETING, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'marketing', name: 'marketing' },
    { spaceId: OLD, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'old', name: 'old', archivedAt: new Date() },
    { spaceId: PRIYA_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'writer', dmUserId: PRIYA, dmAgentName: 'writer' },
    { spaceId: SAM_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'writer', dmUserId: SAM, dmAgentName: 'writer' },
  ]);
  await db.insert(projectSessions).values([
    { sessionId: THREAD, accountId: ACCOUNT, projectId: PROJECT, branchName: 't', createdBy: PRIYA, agentName: 'writer', spaceId: MARKETING, visibility: 'project' },
    { sessionId: PRIVATE_THREAD, accountId: ACCOUNT, projectId: PROJECT, branchName: 'p', createdBy: PRIYA, agentName: 'writer', spaceId: MARKETING, visibility: 'private' },
  ]);
  await db.insert(memoryLayers).values([
    { layerId: L.company, projectId: PROJECT, scope: 'company', importedAt: new Date() },
    { layerId: L.marketing, projectId: PROJECT, scope: 'channel', spaceId: MARKETING, importedAt: new Date() },
    { layerId: L.old, projectId: PROJECT, scope: 'channel', spaceId: OLD, importedAt: new Date() },
    { layerId: L.priya, projectId: PROJECT, scope: 'dm', spaceId: PRIYA_DM, importedAt: new Date() },
    { layerId: L.sam, projectId: PROJECT, scope: 'dm', spaceId: SAM_DM, importedAt: new Date() },
  ]);
  await page(L.company, 'Northwind contact', { type: 'people', body: 'Main contact is Sam; renews in March.' });
  await page(L.marketing, 'Launch pricing', { body: 'Pricing stays at $49 per seat for the launch.' });
  await page(L.marketing, '50% discount rule', { type: 'playbooks', body: 'Never more than half off.' });
  await page(L.marketing, 'Pricing rumor', { status: 'unconfirmed', body: 'Pricing may go to $59.' });
  await page(L.old, 'Old pricing', { body: 'Pricing was $39.' });
  await page(L.priya, 'Priya pricing notes', { type: 'playbooks', body: 'Priya prefers pricing in euros.' });
  await page(L.sam, 'Sam pricing notes', { type: 'playbooks', body: 'Sam keeps pricing private.' });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('the memory a turn carries', () => {
  test('a channel thread: memory_layers for company and channel, and a system list of their confirmed pages', async () => {
    const turn = (await memoryTurnContext(PROJECT, THREAD))!;
    expect(turn.layers.map((layer) => layer.dir)).toEqual(['company', 'channel']);
    expect(turn.system).toContain('### Company\n#### People\n- Northwind contact — About Northwind contact (/opt/kortix/memory/company/people/northwind-contact.md)');
    expect(turn.system).toContain('### #marketing');
    expect(turn.system).toContain('- Launch pricing — About Launch pricing (/opt/kortix/memory/channel/decisions/launch-pricing.md)');
    expect(turn.system).not.toContain('Pricing rumor');
    expect(turn.system).not.toContain('Priya pricing notes');
    expect(turn.loaded.map((layer) => layer.page_ids.length)).toEqual([1, 2]);
    // Unchanged layers: the second turn renders from the cache, same text.
    expect((await memoryTurnContext(PROJECT, THREAD))!.system).toBe(turn.system);
  });

  test('a private channel thread of the DM owner (D3) also lists "Your memory with writer"', async () => {
    const turn = (await memoryTurnContext(PROJECT, PRIVATE_THREAD))!;
    expect(turn.layers.map((layer) => layer.dir)).toEqual(['company', 'channel', 'personal']);
    expect(turn.system).toContain('### Your memory with writer\n#### Playbooks\n- Priya pricing notes');
    expect(turn.system).not.toContain('Sam pricing notes');
  });

  test('the first turn is recorded once; usage drops pages deleted since', async () => {
    const first = (await memoryTurnContext(PROJECT, THREAD))!;
    await recordThreadLoad(THREAD, first.loaded);
    await recordThreadLoad(THREAD, [{ layer_id: L.company, scope: 'company', name: 'Company', version: 99, page_ids: [] }]);
    const before = await threadUsage(THREAD, SAM);
    expect(before.loaded_at).not.toBeNull();
    expect(before.layers.map((layer) => [layer.layer_key, layer.pages.map((p) => p.title)])).toEqual([
      ['company', ['Northwind contact']],
      [MARKETING, expect.arrayContaining(['Launch pricing', '50% discount rule'])],
    ]);
    await db.update(memoryPages).set({ deletedAt: new Date() }).where(eq(memoryPages.pageId, pageIds['Launch pricing']!));
    const after = await threadUsage(THREAD, SAM);
    expect(after.loaded_at).toBe(before.loaded_at);
    expect(after.layers[1]!.pages.map((p) => p.title)).toEqual(['50% discount rule']);
    await db.update(memoryPages).set({ deletedAt: null }).where(eq(memoryPages.pageId, pageIds['Launch pricing']!));
    expect(await threadUsage(PRIVATE_THREAD, PRIYA)).toEqual({ loaded_at: null, layers: [] });
  });

  test('a private thread’s DM layer shows in usage for its owner only', async () => {
    await recordThreadLoad(PRIVATE_THREAD, (await memoryTurnContext(PROJECT, PRIVATE_THREAD))!.loaded);
    expect((await threadUsage(PRIVATE_THREAD, PRIYA)).layers.map((layer) => layer.scope)).toEqual(['company', 'channel', 'dm']);
    expect((await threadUsage(PRIVATE_THREAD, SAM)).layers.map((layer) => layer.scope)).toEqual(['company', 'channel']);
  });
});

describe('memory search', () => {
  const titles = (result: { hits: { title: string }[] }) => result.hits.map((hit) => hit.title).sort();

  test('a person searches company, live channels and their own DM, unconfirmed included; never another member’s DM', async () => {
    const result = await searchMemory(project, person(PRIYA), { q: 'pricing', limit: 20 });
    expect(titles(result)).toEqual(['Launch pricing', 'Pricing rumor', 'Priya pricing notes'].sort());
    const dm = result.hits.find((hit) => hit.title === 'Priya pricing notes')!;
    expect(dm).toMatchObject({ layer_key: PRIYA_DM, layer_name: 'writer', scope: 'dm', type: 'playbooks', status: 'confirmed' });
    expect(dm.snippet).toContain('pricing in euros');
    expect(titles(await searchMemory(project, person(SAM), { q: 'pricing', limit: 20 }))).toContain('Sam pricing notes');
  });

  test('an archived channel is searched only when named; another member’s DM by name is 404', async () => {
    expect(titles(await searchMemory(project, person(PRIYA), { q: 'pricing', layer: OLD, limit: 20 }))).toEqual(['Old pricing']);
    await expect(searchMemory(project, person(PRIYA), { q: 'pricing', layer: SAM_DM, limit: 20 })).rejects.toMatchObject({ status: 404 });
  });

  test('a session token: its thread’s layers, confirmed pages only', async () => {
    expect(titles(await searchMemory(project, agent(THREAD), { q: 'pricing', limit: 20 }))).toEqual(['Launch pricing']);
    expect(titles(await searchMemory(project, agent(PRIVATE_THREAD), { q: 'pricing', limit: 20 }))).toEqual(['Launch pricing', 'Priya pricing notes']);
    await expect(searchMemory(project, agent(THREAD), { q: 'pricing', layer: PRIYA_DM, limit: 20 })).rejects.toMatchObject({ status: 404 });
  });

  test('`%` matches literally through the title fallback; type and limit narrow', async () => {
    expect(titles(await searchMemory(project, person(PRIYA), { q: '50%', limit: 20 }))).toEqual(['50% discount rule']);
    expect(titles(await searchMemory(project, person(PRIYA), { q: '5%', limit: 20 }))).toEqual([]);
    expect(titles(await searchMemory(project, person(PRIYA), { q: 'pricing', type: 'playbooks', limit: 20 }))).toEqual(['Priya pricing notes']);
    expect((await searchMemory(project, person(PRIYA), { q: 'pricing', limit: 1 })).hits).toHaveLength(1);
  });
});
