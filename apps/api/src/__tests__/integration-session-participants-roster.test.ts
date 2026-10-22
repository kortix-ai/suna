/**
 * Integration test (real local DB, real route): GET
 * `/v1/projects/:id/sessions/:id/participants` answers from a LEAN roster read,
 * not the full project access view (KRTX-2727 / KRTX-2180).
 *
 * Measured on prod (Better Stack, kortix_api_logs): the route's p95 sat at
 * ~1.9 s against a 545 ms baseline while every >1 s request spent its time in
 * `db;dur` (avg ~1.28 s over ~6 statements) — pool-wait on a 6-connections-per-
 * task pool, not query time. One of those statements bursts came from
 * `buildProjectAccessView`: SEVEN uncached read-model queries plus a group-
 * member follow-up, an `auth.users` scan of the whole account directory and a
 * `project.members.manage` authorize call — to compute a list the route then
 * threw away down to `members[].user_id`. The route now reads the roster
 * directly: directory, account roles, direct grants and group grants (one
 * parallel burst, one group-member follow-up), folded by the SAME
 * `foldProjectAccess` the access screen uses.
 *
 * This suite pins the result (who can open the session, owner first) and the
 * database work: one `auth.users` identity query per request (the directory
 * scan is gone) and no `account_groups` name read (custom-role bindings,
 * object grants and the manage-probe are not roster inputs at all).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb } from '@kortix/db';
import { beginStage } from '../lib/server-timing';

// Capture every statement this process sends. Installed before anything
// imports `shared/db`, which reuses the instance it finds here for the same
// URL. Static imports above must not load `shared/db` (they are hoisted).
const statements: string[] = [];
const capture = { on: false };
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const globalForDb = globalThis as typeof globalThis & {
  __kortixApiDb?: unknown;
  __kortixApiDbUrl?: string;
};
globalForDb.__kortixApiDb = createDb(
  DATABASE_URL,
  {
    debug: (_connection: number, query: string) => {
      if (capture.on) statements.push(query.replace(/\s+/g, ' ').trim());
    },
  },
  { onQuery: () => beginStage('db') },
);
globalForDb.__kortixApiDbUrl = DATABASE_URL;

const {
  accountMembers,
  accounts,
  accountGroupMembers,
  accountGroups,
  projectGroupGrants,
  projectMembers,
  projectSessionGrants,
  projectSessions,
  projects,
} = await import('@kortix/db');
const { eq, inArray, sql } = await import('drizzle-orm');
const { insertIntoView } = await import('./helpers/compat-views');
const { db } = await import('../shared/db');
const { projectsApp } = await import('../projects/lib/app');
const { registerSessionParticipantsRoutes } = await import('../projects/routes/session-participants');
const { runWithContext } = await import('../lib/request-context');

// The routes run behind a fake auth middleware that puts on the context
// exactly what `jwtPrincipal` puts there for a browser sign-in (userId,
// userEmail, authType 'supabase' — no accountId, no iamTokenId).
const VIEWER = crypto.randomUUID();
projectsApp.use('*', async (c, next) => {
  c.set('userId', VIEWER);
  c.set('userEmail', 'roster-viewer@kortix.test');
  c.set('authType', 'supabase');
  await next();
});
registerSessionParticipantsRoutes();

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = VIEWER; // the viewer is the session owner: canReadMembers is true
const ALICE = crypto.randomUUID(); // account member with no project standing
const BOB = crypto.randomUUID(); // direct project grant
const CAROL = crypto.randomUUID(); // project standing via a group grant
const GROUP = crypto.randomUUID();

const emailOf = (id: string) => `${id}@roster.test`;
const SESSION_PROJECT = `participants-project-${crypto.randomUUID()}`;
const SESSION_RESTRICTED = `participants-restricted-${crypto.randomUUID()}`;

type Measured = { status: number; body: unknown; queries: string[] };

async function getParticipants(sessionId: string): Promise<Measured> {
  statements.length = 0;
  capture.on = true;
  try {
    return await runWithContext('GET', `/v1/projects/${PROJECT}/sessions/${sessionId}/participants`, async () => {
      const res = await projectsApp.request(`/${PROJECT}/sessions/${sessionId}/participants`, {
        method: 'GET',
        headers: { authorization: `Bearer fake-jwt` },
      });
      const body = await res.json();
      // Nothing on this route runs fire-and-forget, but the audit writer and
      // the request-log tap do run off the handler; wait until the statement
      // stream goes quiet so this request's capture stays its own.
      const deadline = Date.now() + 5_000;
      let seen = statements.length;
      let quietSince = Date.now();
      while (Date.now() < deadline && Date.now() - quietSince < 150) {
        await Bun.sleep(25);
        if (statements.length !== seen) {
          seen = statements.length;
          quietSince = Date.now();
        }
      }
      return { status: res.status, body, queries: [...statements] };
    });
  } finally {
    capture.on = false;
  }
}

/** A warm request's statements: IAM memos (principal, capability verdicts) are
 * TTL caches, so the FIRST request pays one-time loads no later request does.
 * The p95 this suite leans on is a per-request structure, so it measures the
 * steady state. */
async function warmAndMeasure(sessionId: string): Promise<Measured> {
  await getParticipants(sessionId);
  return await getParticipants(sessionId);
}

const isAuthUsersRead = (q: string) => q.toLowerCase().includes('from auth.users');
const isAccountGroupsRead = (q: string) => q.toLowerCase().includes('from "kortix"."account_groups"');

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'participants-roster' });
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${OWNER}::uuid, ${emailOf(OWNER)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
           (${ALICE}::uuid, ${emailOf(ALICE)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
           (${BOB}::uuid, ${emailOf(BOB)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
           (${CAROL}::uuid, ${emailOf(CAROL)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
    { userId: ALICE, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: BOB, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    // A group member is an account member: the group grant is her project standing.
    { userId: CAROL, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'participants-roster',
    repoUrl: 'https://example.test/participants-roster.git',
  });
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: BOB, projectRole: 'member' },
  ]);
  await db.insert(accountGroups).values({ groupId: GROUP, accountId: ACCOUNT, name: 'roster-group' });
  await db.insert(accountGroupMembers).values({ groupId: GROUP, userId: CAROL });
  await insertIntoView(db, projectGroupGrants, [
    { accountId: ACCOUNT, projectId: PROJECT, groupId: GROUP, role: 'manager' },
  ]);
  await db.insert(projectSessions).values([
    {
      sessionId: SESSION_PROJECT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: 'roster-project',
      createdBy: OWNER,
      visibility: 'project',
      status: 'running',
    },
    {
      sessionId: SESSION_RESTRICTED,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: 'roster-restricted',
      createdBy: OWNER,
      visibility: 'restricted',
      status: 'running',
    },
  ]);
  await db.insert(projectSessionGrants).values([
    // ALICE is granted the restricted session but holds no project standing:
    // the audience is the roster INTERSECTION, so she stays out (she is not
    // in the roster), exactly as before.
    { sessionId: SESSION_RESTRICTED, principalType: 'member', principalId: ALICE },
    { sessionId: SESSION_RESTRICTED, principalType: 'group', principalId: GROUP },
  ]);
});

afterAll(async () => {
  await db.delete(projectSessions).where(inArray(projectSessions.sessionId, [SESSION_PROJECT, SESSION_RESTRICTED]));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accountGroups).where(eq(accountGroups.groupId, GROUP));
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ALICE}::uuid, ${BOB}::uuid, ${CAROL}::uuid)`);
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('GET /sessions/:id/participants — the roster read (KRTX-2727)', () => {
  test('a project-visibility session lists the roster, owner first', async () => {
    const m = await warmAndMeasure(SESSION_PROJECT);
    expect(m.status).toBe(200);
    const body = m.body as {
      participants: Array<{ user_id: string }>;
      total: number;
      multi_user: boolean;
    };
    const ids = body.participants.map((p) => p.user_id);
    // Owner first; the non-owner members follow in role-rank-then-email order.
    expect(ids[0]).toBe(OWNER);
    expect([...ids.slice(1)].sort()).toEqual([BOB, CAROL].sort());
    expect(body.total).toBe(3);
    expect(body.multi_user).toBe(true);
  });

  test('a restricted session intersects the roster with the session grants', async () => {
    const m = await warmAndMeasure(SESSION_RESTRICTED);
    expect(m.status).toBe(200);
    const body = m.body as {
      participants: Array<{ user_id: string }>;
      total: number;
      multi_user: boolean;
    };
    // OWNER (roster, granted-by-ownership) and CAROL (roster via the group,
    // granted via the group). BOB holds project standing but no grant; ALICE
    // holds the grant but no project standing.
    const ids = body.participants.map((p) => p.user_id);
    expect(ids[0]).toBe(OWNER);
    expect(ids.slice(1)).toEqual([CAROL]);
    expect(body.total).toBe(2);
  });

  test('one auth.users read per request — the directory scan is gone', async () => {
    const m = await warmAndMeasure(SESSION_PROJECT);
    expect(m.status).toBe(200);
    const identityReads = m.queries.filter(isAuthUsersRead);
    // The route resolves identities once, for the audience it lists. Building
    // the full access view used to scan the whole account directory a second
    // time.
    expect(identityReads).toHaveLength(1);
  });

  test('no account_groups read — the roster does not build the access view', async () => {
    const m = await warmAndMeasure(SESSION_PROJECT);
    expect(m.status).toBe(200);
    // `accountGroupNames` exists for the access screen's group labels and the
    // account switcher, not for "who can open this session".
    expect(m.queries.filter(isAccountGroupsRead)).toHaveLength(0);
  });
});
