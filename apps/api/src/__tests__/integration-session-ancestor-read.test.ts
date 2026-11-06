/**
 * Integration test (real local DB): a session token reads the sessions that
 * spawned its session, and nothing else it could not read before.
 *
 * A subagent gets its parent's session id (`KORTIX_PARENT_SESSION_ID`) and
 * reads that conversation with `kortix sessions log <parent>`. The parent is
 * private by default, and often another person's, so the ordinary rules
 * refuse it. The spawn link (`metadata.spawned_by_session`, written only when
 * a box creates its own child) is what grants the read: a person-set
 * `parent_session_id` grants nothing, the read never makes the child an
 * owner, and only a read route (`spawnAncestorRead`) asks for it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import type { Actor } from '../iam/actor';
import { loadVisibleSession } from '../projects/lib/session-visibility';
import type { ProjectRow } from '../projects/lib/serializers';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const LAUNCHER = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const tag = crypto.randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${tag}`;

async function seed(input: { name: string; spawnedBy?: string; parentColumn?: string; createdBy?: string }) {
  await db.insert(projectSessions).values({
    sessionId: id(input.name),
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: id(input.name),
    createdBy: input.createdBy ?? LAUNCHER,
    visibility: 'private',
    parentSessionId: input.parentColumn ? id(input.parentColumn) : null,
    metadata: input.spawnedBy ? { spawned_by_session: id(input.spawnedBy) } : {},
  });
}

let projectRow: ProjectRow;

/** The box token of `session`: an agent-principal session credential of the launcher. */
function boxActor(session: string): Actor {
  return {
    userId: LAUNCHER,
    accountId: ACCOUNT,
    credential: {
      kind: 'agent_session',
      tokenId: crypto.randomUUID(),
      projectId: PROJECT,
      sessionId: id(session),
      agentGrant: null,
      serviceAccountId: crypto.randomUUID(),
      activated: true,
      agentPrincipal: true,
      onBehalfOfUserId: LAUNCHER,
    },
    ctx: {},
  } as unknown as Actor;
}

const readAs = (caller: string, target: string, spawnAncestorRead = true) =>
  loadVisibleSession({ row: projectRow, userId: LAUNCHER, actor: boxActor(caller) }, id(target), id(caller), id(caller), {
    spawnAncestorRead,
  });

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-ancestor-read-test' });
  [projectRow] = (await db
    .insert(projects)
    .values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' })
    .returning()) as ProjectRow[];
  // root (another person's) → child → grandchild, a sibling of the child, and
  // a session whose parent column alone names root.
  await seed({ name: 'root', createdBy: OTHER });
  await seed({ name: 'child', spawnedBy: 'root', parentColumn: 'root' });
  await seed({ name: 'grandchild', spawnedBy: 'child', parentColumn: 'child' });
  await seed({ name: 'sibling', createdBy: OTHER });
  await seed({ name: 'adopted', parentColumn: 'root' });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions
});

describe('a session token reads the sessions that spawned it', () => {
  test('a child reads its private parent, as a reader, never an owner', async () => {
    const access = await readAs('child', 'root');
    expect(access?.row.sessionId).toBe(id('root'));
    expect(access?.isOwner).toBe(false);
    expect(access?.canManageLifecycle).toBe(false);
  });

  test('a route that may change the session (a prompt, a permission answer) never sees the parent', async () => {
    expect(await readAs('child', 'root', false)).toBeNull();
  });

  test('a grandchild reads every session up its spawn chain', async () => {
    expect((await readAs('grandchild', 'child'))?.row.sessionId).toBe(id('child'));
    expect((await readAs('grandchild', 'root'))?.row.sessionId).toBe(id('root'));
  });

  test('a session the chain does not contain stays hidden', async () => {
    expect(await readAs('child', 'sibling')).toBeNull();
  });

  test('a person-set parent_session_id grants no read', async () => {
    expect(await readAs('adopted', 'root')).toBeNull();
  });

  test('the parent still owns its child', async () => {
    const access = await readAs('child', 'grandchild');
    expect(access?.isOwner).toBe(true);
  });

  test('a person who cannot see the parent still cannot', async () => {
    const access = await loadVisibleSession({ row: projectRow, userId: LAUNCHER, actor: null }, id('root'), null, null);
    expect(access).toBeNull();
  });
});
