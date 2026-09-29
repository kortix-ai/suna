/**
 * Integration test (real local DB): the session list's `parent`, `started_by`
 * and `q` filters (KRTX-639).
 *
 * A project whose triggers spawn hundreds of workers buried every human chat.
 * The list could only be searched client-side over the pages already loaded,
 * so a chat from yesterday was unfindable. These filters run in SQL, before
 * the keyset page, so every page is full and search reaches every session the
 * viewer may see.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { loadProjectSessionInventory, type SessionListFilter } from '../projects/lib/session-list';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const VIEWER = crypto.randomUUID();
const TEAMMATE = crypto.randomUUID();
const tag = crypto.randomUUID().slice(0, 8);
const sid = (id: string) => `${id}-${tag}`;

type Initiator = { type: 'member' | 'trigger' | 'channel' | 'api' | 'system'; id: string | null } | null;

async function seed(input: {
  id: string;
  minutesAgo: number;
  parent?: string;
  initiator: Initiator;
  name?: string;
  createdBy?: string;
  visibility?: 'project' | 'private';
  deleted?: boolean;
  agentName?: string;
}) {
  const at = new Date(Date.now() - input.minutesAgo * 60_000);
  await db.insert(projectSessions).values({
    sessionId: sid(input.id),
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sid(input.id),
    createdBy: input.createdBy ?? VIEWER,
    visibility: input.visibility ?? 'project',
    parentSessionId: input.parent ? sid(input.parent) : null,
    initiatorType: input.initiator?.type ?? null,
    initiatorId: input.initiator?.id ?? null,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    metadata: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.parent ? { spawned_by_session: sid(input.parent) } : {}),
      ...(input.deleted ? { deletedAt: at.toISOString() } : {}),
    },
    createdAt: at,
    updatedAt: at,
  });
}

const list = (filter: SessionListFilter, opts: { limit?: number; cursor?: string | null; manager?: boolean } = {}) =>
  loadProjectSessionInventory({
    projectId: PROJECT,
    accountId: ACCOUNT,
    userId: VIEWER,
    effectiveRole: 'write' as never,
    scope: opts.manager ? 'project' : 'visible',
    boundCredentialSessionId: null,
    probeManageCapability: async () => opts.manager === true,
    limit: opts.limit ?? 50,
    cursor: opts.cursor ?? null,
    filter,
  });

const ids = (items: { row: { sessionId: string } }[]) => items.map((item) => item.row.sessionId.replace(`-${tag}`, ''));

const me: Initiator = { type: 'member', id: VIEWER };
const teammate: Initiator = { type: 'member', id: TEAMMATE };
const factory: Initiator = { type: 'trigger', id: 'software-factory' };

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-list-filters-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
  // A trigger coordinator with 3 workers (one soft-deleted), 120 newer
  // automated runs, and the viewer's day-old chat far below them.
  await seed({ id: 'factory', minutesAgo: 30, initiator: factory, name: 'Factory intake' });
  await seed({ id: 'worker-a', minutesAgo: 5, parent: 'factory', initiator: factory, name: 'Fix login bug' });
  await seed({ id: 'worker-b', minutesAgo: 6, parent: 'factory', initiator: factory, name: 'Rent ledger probe' });
  await seed({ id: 'worker-gone', minutesAgo: 7, parent: 'factory', initiator: factory, deleted: true });
  for (let i = 0; i < 120; i += 1) {
    await seed({ id: `cron-${i}`, minutesAgo: 40 + i, initiator: { type: 'trigger', id: 'nightly' }, name: `Nightly ${i}` });
  }
  await seed({ id: 'my-chat', minutesAgo: 1440, initiator: me, name: 'Apartment rent research' });
  await seed({ id: 'my-helper', minutesAgo: 1441, parent: 'my-chat', initiator: me, name: 'Helper' });
  await db.execute(
    sql`insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
        values (${TEAMMATE}, ${`dana-${tag}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify({ full_name: `Dana ${tag}` })}::jsonb)`,
  );
  await seed({ id: 'teammate-chat', minutesAgo: 1500, initiator: teammate, createdBy: TEAMMATE, name: 'Teammate plan', agentName: `pentester-${tag}` });
  await seed({ id: 'legacy-mine', minutesAgo: 1600, initiator: null, name: 'Old unclassified chat' });
  await seed({ id: 'odd%name', minutesAgo: 1700, initiator: me, name: '100% done_list' });
  await seed({
    id: 'private-other',
    minutesAgo: 1800,
    initiator: teammate,
    createdBy: TEAMMATE,
    visibility: 'private',
    name: 'Secret rent notes',
  });
});

afterAll(async () => {
  await db.execute(sql`delete from auth.users where id = ${TEAMMATE}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions
});

describe('session list filters', () => {
  test('parent=root serves only top-level sessions, with non-deleted child counts', async () => {
    const page = await list({ parent: 'root' }, { limit: 200 });
    const served = ids(page.items);
    expect(served).toContain('factory');
    expect(served).not.toContain('worker-a');
    expect(served).not.toContain('my-helper');
    expect(page.childCounts.get(sid('factory'))).toBe(2);
    expect(page.childCounts.get(sid('my-chat'))).toBe(1);
    expect(page.childCounts.has(sid('teammate-chat'))).toBe(false);
  });

  test('parent=<id> serves that session’s children, newest first, and no ancestors', async () => {
    const page = await list({ parent: sid('factory') });
    expect(ids(page.items)).toEqual(['worker-a', 'worker-b']);
  });

  test('started_by=me is the viewer’s own chats (unclassified rows count by owner)', async () => {
    const page = await list({ parent: 'root', startedBy: 'me' });
    expect(ids(page.items)).toEqual(['my-chat', 'legacy-mine', 'odd%name']);
  });

  test('started_by=others and automated split the rest', async () => {
    expect(ids((await list({ parent: 'root', startedBy: 'others' })).items)).toEqual(['teammate-chat']);
    const automated = ids((await list({ parent: 'root', startedBy: 'automated' }, { limit: 200 })).items);
    expect(automated).toHaveLength(121);
    expect(automated[0]).toBe('factory');
    expect(automated).not.toContain('my-chat');
  });

  test('q finds a day-old chat below 120 newer automated runs', async () => {
    const unfiltered = await list({}, { limit: 50 });
    expect(ids(unfiltered.items)).not.toContain('my-chat');
    const found = await list({ parent: 'root', q: 'apartment RENT' });
    expect(ids(found.items)).toEqual(['my-chat']);
  });

  test('q with parent=root also returns a root whose child matched', async () => {
    const found = ids((await list({ parent: 'root', q: 'rent' })).items);
    expect(found).toEqual(['factory', 'my-chat']);
    const children = ids((await list({ parent: sid('factory'), q: 'rent' })).items);
    expect(children).toEqual(['worker-b']);
  });

  test('q matches the trigger slug and a session-id prefix', async () => {
    expect(ids((await list({ parent: 'root', q: 'software-fact' })).items)).toEqual(['factory']);
    expect(ids((await list({ q: 'teammate-chat' })).items)).toEqual(['teammate-chat']);
  });

  test('q matches the owner’s email and name, and the agent', async () => {
    // The teammate also owns 'private-other'; the viewer may not see it, so it never matches.
    expect(ids((await list({ q: `dana-${tag}@` })).items)).toEqual(['teammate-chat']);
    expect(ids((await list({ q: `Dana ${tag}` })).items)).toEqual(['teammate-chat']);
    expect(ids((await list({ q: `pentester-${tag}` })).items)).toEqual(['teammate-chat']);
  });

  test('q treats % and _ literally', async () => {
    // Unescaped, '%100%%' would also match "Nightly 100", and 'y_1' "Nightly 1…".
    expect(ids((await list({ q: '100%' })).items)).toEqual(['odd%name']);
    expect(ids((await list({ q: 'e_l' })).items)).toEqual(['odd%name']);
    expect(ids((await list({ q: 'y_1' })).items)).toEqual([]);
  });

  test('q never matches a title the viewer may not open, even in a manager inventory', async () => {
    const managed = await list({ q: 'secret rent' }, { manager: true });
    expect(ids(managed.items)).toEqual([]);
  });

  test('a filtered cursor pages that filter and is refused under another', async () => {
    const first = await list({ parent: 'root', startedBy: 'me' }, { limit: 1 });
    expect(ids(first.items)).toEqual(['my-chat']);
    const second = await list({ parent: 'root', startedBy: 'me' }, { limit: 1, cursor: first.nextCursor });
    expect(ids(second.items)).toEqual(['legacy-mine']);
    // The same cursor under a different filter does not decrypt: the list starts over.
    const foreign = await list({ parent: 'root', startedBy: 'others' }, { limit: 1, cursor: first.nextCursor });
    expect(ids(foreign.items)).toEqual(['teammate-chat']);
  });
});
