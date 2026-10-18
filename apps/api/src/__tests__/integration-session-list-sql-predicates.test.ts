/**
 * Integration test (real local PostgreSQL, fully migrated): the session list
 * reads only the rows its viewer may see (KRTX-2316, scenarios A and B of
 * KRTX-1727).
 *
 * The page used to read fixed chunks and drop tombstones, warm drafts and
 * other members' private sessions in JavaScript. After 8 chunks it gave up: a
 * member whose project had 1,000 newer private sessions got an empty page with
 * a cursor, and an owner who deleted 1,500 sessions got the same. The page
 * WHERE now carries those rules (`sessionListViewerSql`), and the JS fold
 * re-checks each row.
 *
 * The equivalence block runs the SQL predicate and the JS fold over the same
 * rows for every viewer shape, so a rule changed on one side alone fails here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountGroupMembers,
  accountGroups,
  accounts,
  projectSessionGrants,
  projectSessions,
  projects,
} from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';

import { loadSessionGrants, resolveShareSubject } from '../connectors/share';
import { selectSessionRowsForViewer } from '../projects/lib/session-inventory';
import {
  loadProjectSessionInventory,
  type SessionListFilter,
  sessionListViewerSql,
} from '../projects/lib/session-list';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT_A = crypto.randomUUID();
const PROJECT_B = crypto.randomUUID();
const PROJECT_RULES = crypto.randomUUID();
const MEMBER_A = crypto.randomUUID();
const MEMBER_B = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const GROUP_WITH_B = crypto.randomUUID();
const GROUP_EMPTY = crypto.randomUUID();
const tag = crypto.randomUUID().slice(0, 8);
const sid = (id: string) => `${tag}-${id}`;
const short = (id: string) => id.slice(tag.length + 1);

type Visibility = 'private' | 'project' | 'restricted';

async function seed(input: {
  project: string;
  id: string;
  createdBy: string | null;
  visibility: Visibility;
  minutesAgo: number;
  initiator?: 'member' | 'trigger' | null;
  origin?: 'user' | 'backend';
  metadata?: Record<string, unknown> | null;
}) {
  const at = new Date(Date.now() - input.minutesAgo * 60_000);
  await db.insert(projectSessions).values({
    sessionId: sid(input.id),
    accountId: ACCOUNT,
    projectId: input.project,
    branchName: sid(input.id),
    createdBy: input.createdBy,
    visibility: input.visibility,
    origin: input.origin ?? 'user',
    initiatorType: input.initiator === undefined ? 'member' : input.initiator,
    initiatorId: input.initiator === 'trigger' ? 'nightly' : input.createdBy,
    metadata: input.metadata === undefined ? {} : input.metadata,
    createdAt: at,
    updatedAt: at,
  });
}

/** `count` rows in one statement; row g is `g` seconds older than `newestSecondsAgo`. */
async function seedMany(input: {
  project: string;
  prefix: string;
  count: number;
  newestSecondsAgo: number;
  createdBy: string;
  initiator: 'member' | 'trigger';
  metadata: Record<string, unknown>;
}) {
  await db.execute(sql`
    insert into kortix.project_sessions
      (session_id, account_id, project_id, branch_name, created_by, visibility,
       initiator_type, initiator_id, metadata, created_at, updated_at)
    select ${`${tag}-${input.prefix}-`} || g, ${ACCOUNT}::uuid, ${input.project}::uuid,
           ${`${tag}-${input.prefix}-`} || g, ${input.createdBy}::uuid, 'private',
           ${input.initiator}::kortix.project_session_initiator,
           ${input.initiator === 'member' ? input.createdBy : 'nightly'},
           ${JSON.stringify(input.metadata)}::jsonb,
           now() - make_interval(secs => ${input.newestSecondsAgo} + g),
           now() - make_interval(secs => ${input.newestSecondsAgo} + g)
      from generate_series(1, ${input.count}) as g`);
}

async function grant(sessionId: string, principalType: 'member' | 'group', principalId: string) {
  await db.insert(projectSessionGrants).values({ sessionId: sid(sessionId), principalType, principalId });
}

const page = (input: {
  project: string;
  viewer: string;
  manager?: boolean;
  scope?: 'visible' | 'project';
  limit: number;
  cursor?: string | null;
  filter?: SessionListFilter;
}) =>
  loadProjectSessionInventory({
    projectId: input.project,
    accountId: ACCOUNT,
    userId: input.viewer,
    scope: input.scope ?? 'visible',
    boundCredentialSessionId: null,
    probeManageCapability: async () => input.manager === true,
    limit: input.limit,
    cursor: input.cursor ?? null,
    filter: input.filter,
  });

/** Every page of one list, with the number of requests it took. */
async function walk(input: Omit<Parameters<typeof page>[0], 'cursor'>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let requests = 0;
  do {
    const result = await page({ ...input, cursor });
    requests += 1;
    ids.push(...result.items.map((item) => short(item.row.sessionId)));
    cursor = result.nextCursor;
  } while (cursor && requests < 50);
  return { ids, requests };
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-list-sql-predicates-test' });
  for (const projectId of [PROJECT_A, PROJECT_B, PROJECT_RULES]) {
    await db.insert(projects).values({ projectId, accountId: ACCOUNT, name: projectId, repoUrl: 'https://example.test/p.git' });
  }
  await db.insert(accountGroups).values([
    { groupId: GROUP_WITH_B, accountId: ACCOUNT, name: 'with-b' },
    { groupId: GROUP_EMPTY, accountId: ACCOUNT, name: 'empty' },
  ]);
  await db.insert(accountGroupMembers).values({ groupId: GROUP_WITH_B, userId: MEMBER_B });

  // Scenario A: member A shared one session 2 days ago, then started 1,000
  // private chats and a private trigger ran 300 times. Three restricted
  // sessions sit among the private chats.
  await seed({ project: PROJECT_A, id: 'shared-old', createdBy: MEMBER_A, visibility: 'project', minutesAgo: 2 * 1440 });
  await seedMany({ project: PROJECT_A, prefix: 'private', count: 1000, newestSecondsAgo: 0, createdBy: MEMBER_A, initiator: 'member', metadata: {} });
  await seedMany({ project: PROJECT_A, prefix: 'trigger', count: 300, newestSecondsAgo: 0, createdBy: MEMBER_A, initiator: 'trigger', metadata: {} });
  for (const [index, id] of ['granted-member', 'granted-group', 'granted-other'].entries()) {
    await seed({ project: PROJECT_A, id, createdBy: MEMBER_A, visibility: 'restricted', minutesAgo: 8 + index });
  }
  await grant('granted-member', 'member', MEMBER_B);
  await grant('granted-group', 'group', GROUP_WITH_B);
  await grant('granted-other', 'group', GROUP_EMPTY);

  // Scenario B: the owner deleted 1,500 sessions newer than their 60 live
  // ones, and 20 unprompted warm drafts are newer still.
  for (let i = 0; i < 60; i += 1) {
    await seed({ project: PROJECT_B, id: `live-${i}`, createdBy: OWNER, visibility: 'private', minutesAgo: 60 + i });
  }
  await seedMany({
    project: PROJECT_B,
    prefix: 'deleted',
    count: 1500,
    newestSecondsAgo: 60,
    createdBy: OWNER,
    initiator: 'member',
    metadata: { deletedAt: new Date().toISOString(), deletedBy: OWNER },
  });
  await seedMany({ project: PROJECT_B, prefix: 'warm', count: 20, newestSecondsAgo: 0, createdBy: OWNER, initiator: 'member', metadata: { warm: true } });

  // One row per rule of `isProjectSessionVisibleTo` and the scope filters.
  const rules: Array<Omit<Parameters<typeof seed>[0], 'project' | 'minutesAgo'>> = [
    { id: 'private-a', createdBy: MEMBER_A, visibility: 'private' },
    { id: 'private-b', createdBy: MEMBER_B, visibility: 'private' },
    { id: 'project-a', createdBy: MEMBER_A, visibility: 'project' },
    { id: 'restricted-member-b', createdBy: MEMBER_A, visibility: 'restricted' },
    { id: 'restricted-group-b', createdBy: MEMBER_A, visibility: 'restricted' },
    { id: 'restricted-group-empty', createdBy: MEMBER_A, visibility: 'restricted' },
    { id: 'restricted-b-no-grant', createdBy: MEMBER_B, visibility: 'restricted' },
    { id: 'trigger-initiator', createdBy: MEMBER_A, visibility: 'private', initiator: 'trigger' },
    {
      id: 'trigger-created',
      createdBy: MEMBER_A,
      visibility: 'private',
      initiator: null,
      metadata: { source: 'trigger:nightly', trigger_kind: 'git', trigger_slug: 'nightly' },
    },
    {
      id: 'trigger-partial-marker',
      createdBy: MEMBER_A,
      visibility: 'private',
      initiator: null,
      metadata: { source: 'trigger:nightly', trigger_kind: 'cron', trigger_slug: 'nightly' },
    },
    { id: 'warm-private-a', createdBy: MEMBER_A, visibility: 'private', metadata: { warm: true } },
    { id: 'warm-project-a', createdBy: MEMBER_A, visibility: 'project', metadata: { warm: true } },
    { id: 'warm-false', createdBy: MEMBER_A, visibility: 'project', metadata: { warm: false } },
    { id: 'deleted-project-a', createdBy: MEMBER_A, visibility: 'project', metadata: { deletedAt: '2026-10-01T00:00:00.000Z' } },
    {
      id: 'deleted-warm-project-a',
      createdBy: MEMBER_A,
      visibility: 'project',
      metadata: { deletedAt: '2026-10-01T00:00:00.000Z', warm: true },
    },
    { id: 'deleted-private-b', createdBy: MEMBER_B, visibility: 'private', metadata: { deletedAt: '2026-10-01T00:00:00.000Z' } },
    { id: 'backend-project', createdBy: MEMBER_A, visibility: 'project', origin: 'backend' },
    { id: 'backend-own', createdBy: MEMBER_A, visibility: 'private', origin: 'backend' },
    { id: 'spawned-by-backend-own', createdBy: MEMBER_A, visibility: 'private', metadata: { spawned_by_session: sid('backend-own') } },
    {
      id: 'backend-spawned-by-backend-own',
      createdBy: MEMBER_A,
      visibility: 'private',
      origin: 'backend',
      metadata: { spawned_by_session: sid('backend-own') },
    },
    { id: 'null-metadata', createdBy: MEMBER_A, visibility: 'project', metadata: null },
    { id: 'no-owner', createdBy: null, visibility: 'private' },
  ];
  for (const [index, row] of rules.entries()) {
    await seed({ project: PROJECT_RULES, minutesAgo: index + 1, ...row });
  }
  await grant('restricted-member-b', 'member', MEMBER_B);
  await grant('restricted-group-b', 'group', GROUP_WITH_B);
  await grant('restricted-group-empty', 'group', GROUP_EMPTY);

  await db.execute(sql`analyze kortix.project_sessions`);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions, grants, groups
});

describe('scenario A: older shared sessions below 1,000 newer private ones', () => {
  test("member B's Shared query (parent=root, started_by=others, limit=20) returns them on page 1", async () => {
    const result = await page({
      project: PROJECT_A,
      viewer: MEMBER_B,
      limit: 20,
      filter: { parent: 'root', startedBy: 'others' },
    });
    expect(result.items.map((item) => short(item.row.sessionId))).toEqual([
      'granted-member',
      'granted-group',
      'shared-old',
    ]);
    // The list ends here: no empty page with a cursor follows.
    expect(result.nextCursor).toBeNull();
  });

  test('member B never receives a private session or a restricted one granted to others, on any page', async () => {
    const { ids, requests } = await walk({ project: PROJECT_A, viewer: MEMBER_B, limit: 200 });
    expect(ids).toEqual(['granted-member', 'granted-group', 'shared-old']);
    expect(requests).toBe(1);
  });

  test('a manager reads every trigger run, and still no member-private chat, in full pages', async () => {
    const first = await page({ project: PROJECT_A, viewer: MANAGER, manager: true, limit: 200 });
    expect(first.items).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();
    const { ids, requests } = await walk({ project: PROJECT_A, viewer: MANAGER, manager: true, limit: 200 });
    expect(requests).toBe(2);
    expect(ids).toHaveLength(301);
    expect(ids.filter((id) => id.startsWith('trigger-'))).toHaveLength(300);
    expect(ids.at(-1)).toBe('shared-old');
    expect(ids.some((id) => id.startsWith('private-') || id.startsWith('granted-'))).toBe(false);
  });
});

describe('scenario B: 1,500 tombstones newer than the owner’s live sessions', () => {
  test("the owner's first visible page holds 50 live sessions, newest first", async () => {
    const result = await page({ project: PROJECT_B, viewer: OWNER, limit: 50 });
    expect(result.items.map((item) => short(item.row.sessionId))).toEqual(
      Array.from({ length: 50 }, (_, i) => `live-${i}`),
    );
    expect(result.nextCursor).not.toBeNull();
    const second = await page({ project: PROJECT_B, viewer: OWNER, limit: 50, cursor: result.nextCursor });
    expect(second.items.map((item) => short(item.row.sessionId))).toEqual(
      Array.from({ length: 10 }, (_, i) => `live-${50 + i}`),
    );
    expect(second.nextCursor).toBeNull();
  });

  test('the manager inventory excludes tombstones and unused warm drafts', async () => {
    const { ids, requests } = await walk({ project: PROJECT_B, viewer: OWNER, manager: true, scope: 'project', limit: 200 });
    expect(ids.filter((id) => id.startsWith('deleted-'))).toHaveLength(0);
    expect(ids.filter((id) => id.startsWith('live-'))).toHaveLength(60);
    expect(ids.filter((id) => id.startsWith('warm-'))).toHaveLength(0);
    expect(requests).toBe(1);
  });

  test('the visible page walks idx_project_sessions_project_live in list order, with no sort, with and without a generic plan', async () => {
    const query = db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, PROJECT_B),
          eq(projectSessions.accountId, ACCOUNT),
          sessionListViewerSql({
            scope: 'visible',
            viewerId: OWNER,
            boundCredentialSessionId: null,
            agentPrincipal: false,
            canManageProject: false,
            accountSessionOversight: false,
          }),
        ),
      )
      .orderBy(desc(projectSessions.updatedAt), desc(projectSessions.sessionId))
      .limit(51);
    const plans = await db.transaction(async (tx) => {
      const planText = async () =>
        ((await tx.execute(sql`explain (costs off) ${query}`)) as unknown as Array<Record<string, string>>)
          .map((row) => Object.values(row)[0])
          .join('\n');
      const custom = await planText();
      await tx.execute(sql`set local plan_cache_mode = force_generic_plan`);
      return { custom, generic: await planText() };
    });
    // The owner's 60 live sessions outnumber the page, so the plan walks the
    // index head in list order and stops after 51 matching rows. A Sort node
    // means it read every live row of the project first: an index whose column
    // or NULLS order differs from the page ORDER BY, or a predicate that hides
    // `created_by`'s statistics from the planner (with `created_by::text`,
    // 10 of 20 runs sorted).
    for (const plan of [plans.custom, plans.generic]) {
      expect(plan).toContain('idx_project_sessions_project_live');
      expect(plan).not.toContain('idx_project_sessions_project_updated');
      expect(plan).not.toMatch(/\bSort\b/);
    }
  });
});

describe('the page WHERE agrees with the JS fold on every rule', () => {
  const viewers = [MEMBER_A, MEMBER_B, crypto.randomUUID()];
  const bindings = [null, sid('backend-own'), sid('private-a')];

  test('for every viewer, binding, agent principal, standing and oversight', async () => {
    const rows = await db.select().from(projectSessions).where(eq(projectSessions.projectId, PROJECT_RULES));
    const grantsBySession = await loadSessionGrants(rows.map((row) => row.sessionId));
    let compared = 0;
    for (const viewerId of viewers) {
      const subject = await resolveShareSubject(viewerId);
      for (const scope of ['visible', 'project'] as const) {
        for (const bound of bindings) {
          for (const agentPrincipal of [false, true]) {
            for (const canManageProject of [false, true]) {
              // The loader refuses the manager scope without standing before any read.
              if (scope === 'project' && !canManageProject) continue;
              for (const accountSessionOversight of [false, true]) {
                const viewer = { scope, viewerId, boundCredentialSessionId: bound, agentPrincipal, canManageProject, accountSessionOversight };
                const fromSql = await db
                  .select({ sessionId: projectSessions.sessionId })
                  .from(projectSessions)
                  .where(and(eq(projectSessions.projectId, PROJECT_RULES), sessionListViewerSql(viewer)));
                const fromJs = selectSessionRowsForViewer({
                  rows,
                  scope,
                  canManageProject,
                  subject,
                  callerSessionId: bound,
                  boundCredentialSessionId: bound,
                  grantsBySession,
                  runtimeStatusBySession: new Map(),
                  accountSessionOversight,
                  agentPrincipal,
                });
                const label = JSON.stringify({ ...viewer, viewerId: viewers.indexOf(viewerId) });
                expect({ label, ids: fromSql.map((row) => short(row.sessionId)).sort() }).toEqual({
                  label,
                  ids: fromJs.items.map((item) => short(item.row.sessionId)).sort(),
                });
                compared += 1;
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(3 * 3 * 2 * (2 + 1) * 2);
  });

  test('the fixture reaches every rule: member B sees grants and project rows, never another private row', async () => {
    const { ids } = await walk({ project: PROJECT_RULES, viewer: MEMBER_B, limit: 200 });
    expect(ids.sort()).toEqual(
      [
        'backend-project',
        'null-metadata',
        'private-b',
        'project-a',
        'restricted-b-no-grant',
        'restricted-group-b',
        'restricted-member-b',
        'warm-false',
      ].sort(),
    );
  });
});
