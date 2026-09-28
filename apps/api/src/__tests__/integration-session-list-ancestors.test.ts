/**
 * Integration test (real local DB): a session-list page serves the coordinator
 * of every sub-agent session on it.
 *
 * The list is a keyset page in `updated_at DESC`. A sub-agent's turns never
 * touch its coordinator's row, so a coordinator that went quiet while its
 * sub-agents kept working sorts onto a LATER page. Before the ancestor fill,
 * page 1 held the children without their parent, and every client rendered
 * them as stray top-level rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { loadProjectSessionInventory } from '../projects/lib/session-list';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const VIEWER = crypto.randomUUID();
const OTHER_MEMBER = crypto.randomUUID();
const tag = crypto.randomUUID().slice(0, 8);

async function seed(input: {
  id: string;
  minutesAgo: number;
  parent?: string;
  visibility?: 'project' | 'private';
  createdBy?: string;
}) {
  const at = new Date(Date.now() - input.minutesAgo * 60_000);
  await db.insert(projectSessions).values({
    sessionId: `${input.id}-${tag}`,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `${input.id}-${tag}`,
    createdBy: input.createdBy ?? VIEWER,
    visibility: input.visibility ?? 'project',
    metadata: input.parent ? { spawned_by_session: `${input.parent}-${tag}` } : {},
    createdAt: at,
    updatedAt: at,
  });
}

const page = (limit: number, cursor: string | null = null) =>
  loadProjectSessionInventory({
    projectId: PROJECT,
    accountId: ACCOUNT,
    userId: VIEWER,
    effectiveRole: 'write' as never,
    scope: 'visible',
    boundCredentialSessionId: null,
    probeManageCapability: async () => false,
    limit,
    cursor,
  });

const ids = (items: { row: { sessionId: string } }[]) =>
  items.map((item) => item.row.sessionId.replace(`-${tag}`, ''));

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-list-ancestors-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
  // Newest first: two working sub-agents, a grandchild, then filler that
  // pushes the quiet coordinators off page 1.
  await seed({ id: 'child-a', minutesAgo: 1, parent: 'coord' });
  await seed({ id: 'grandchild', minutesAgo: 2, parent: 'child-b' });
  await seed({ id: 'hidden-child', minutesAgo: 3, parent: 'private-coord' });
  for (let i = 0; i < 5; i += 1) await seed({ id: `filler-${i}`, minutesAgo: 10 + i });
  await seed({ id: 'child-b', minutesAgo: 60, parent: 'coord' });
  await seed({ id: 'coord', minutesAgo: 120 });
  await seed({
    id: 'private-coord',
    minutesAgo: 130,
    visibility: 'private',
    createdBy: OTHER_MEMBER,
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions
});

describe('loadProjectSessionInventory — spawn ancestors', () => {
  test('page 1 carries the coordinator chain of every sub-agent on it', async () => {
    const first = await page(3);
    // The keyset page itself, then the ancestors: child-b (the grandchild's
    // parent), then coord (the parent of child-a and child-b).
    expect(ids(first.items)).toEqual([
      'child-a',
      'grandchild',
      'hidden-child',
      'child-b',
      'coord',
    ]);
    expect(first.nextCursor).not.toBeNull();
  });

  test('an ancestor the viewer may not see stays out of the page', async () => {
    const first = await page(3);
    expect(ids(first.items)).not.toContain('private-coord');
  });

  test('the cursor ignores ancestors: page 2 resumes after the keyset tail', async () => {
    const first = await page(3);
    const second = await page(10, first.nextCursor);
    expect(ids(second.items)).toEqual([
      'filler-0',
      'filler-1',
      'filler-2',
      'filler-3',
      'filler-4',
      'child-b',
      'coord',
    ]);
    expect(second.nextCursor).toBeNull();
  });
});
