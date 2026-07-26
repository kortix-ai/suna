import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountMembers, accounts, agiTasks, projectMembers, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { app } from '../../index';
import { createAccountToken } from '../../repositories/account-tokens';

// Real-DB integration over the mounted app: the claim is a property of the SQL
// (one conditional UPDATE, decided by Postgres), so mocking the db layer would
// test nothing that matters here.
//
// The `integration-` filename prefix is load-bearing, not decoration: scripts/
// test.sh's default bucket is `find src -name '*.test.ts' ! -name 'integration-*'`,
// which is the suite CI runs without a database. This file needs one.
// Run it with:
//   KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- \
//     bun test src/agi/tasks/integration-agi-tasks-http.test.ts
const ACCOUNT = crypto.randomUUID();
const OUTSIDER_ACCOUNT = crypto.randomUUID();
// agi ON, agi OFF, and a second agi-ON workspace used to prove cross-workspace
// task ids are 404 rather than 403.
const WORKSPACE = crypto.randomUUID();
const WORKSPACE_OFF = crypto.randomUUID();
const OTHER_WORKSPACE = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();

const minted: string[] = [];
let ownerToken = '';
let outsiderToken = '';

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'agi-tasks-test' },
    { accountId: OUTSIDER_ACCOUNT, name: 'agi-tasks-test-outsider' },
  ]);
  await db.insert(projects).values([
    {
      projectId: WORKSPACE,
      accountId: ACCOUNT,
      name: 'agi-tasks-test-workspace',
      repoUrl: 'https://example.com/agi-tasks-test.git',
      metadata: { experimental: { agi: true } },
    },
    {
      projectId: WORKSPACE_OFF,
      accountId: ACCOUNT,
      name: 'agi-tasks-test-workspace-off',
      repoUrl: 'https://example.com/agi-tasks-test-off.git',
    },
    {
      projectId: OTHER_WORKSPACE,
      accountId: ACCOUNT,
      name: 'agi-tasks-test-other-workspace',
      repoUrl: 'https://example.com/agi-tasks-test-other.git',
      metadata: { experimental: { agi: true } },
    },
  ]);
  await db.insert(accountMembers).values([
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
    { userId: OUTSIDER, accountId: OUTSIDER_ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
  ]);
  await db.insert(projectMembers).values(
    [WORKSPACE, WORKSPACE_OFF, OTHER_WORKSPACE].map((projectId) => ({
      accountId: ACCOUNT,
      projectId,
      userId: OWNER,
      projectRole: 'manager' as const,
    })),
  );

  ownerToken = await mint(ACCOUNT, OWNER);
  outsiderToken = await mint(OUTSIDER_ACCOUNT, OUTSIDER);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(inArray(projects.accountId, [ACCOUNT, OUTSIDER_ACCOUNT]));
  await db.delete(accounts).where(inArray(accounts.accountId, [ACCOUNT, OUTSIDER_ACCOUNT]));
});

async function mint(accountId: string, userId: string): Promise<string> {
  const token = await createAccountToken({ accountId, userId, name: 'agi-tasks-test' });
  minted.push(token.tokenId);
  return token.secretKey;
}

function req(method: string, path: string, secret: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const tasksPath = (workspace = WORKSPACE) => `/v1/projects/${workspace}/agi/tasks`;

async function newTask(
  body: Record<string, unknown> = {},
  workspace = WORKSPACE,
): Promise<Record<string, any>> {
  const res = await req('POST', tasksPath(workspace), ownerToken, {
    title: 'contended work',
    origin: 'agi',
    ...body,
  });
  expect(res.status).toBe(201);
  return (await res.json()).task;
}

describe('experimental gate (R-44)', () => {
  const routes: Array<{ name: string; method: string; suffix: string; body?: unknown }> = [
    { name: 'list', method: 'GET', suffix: '' },
    { name: 'get', method: 'GET', suffix: `/${crypto.randomUUID()}` },
    { name: 'create', method: 'POST', suffix: '', body: { title: 'x', origin: 'human' } },
    { name: 'patch', method: 'PATCH', suffix: `/${crypto.randomUUID()}`, body: { status: 'todo' } },
    { name: 'claim', method: 'POST', suffix: `/${crypto.randomUUID()}/claim`, body: { session_id: 's' } },
    { name: 'release', method: 'POST', suffix: `/${crypto.randomUUID()}/release`, body: { session_id: 's' } },
  ];

  test.each(routes)('$name 404s when the project has not enabled agi', async (route) => {
    const res = await req(
      route.method,
      `${tasksPath(WORKSPACE_OFF)}${route.suffix}`,
      ownerToken,
      route.body,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('AGI is not enabled for this project');
  });

  test('the same routes are reachable once the project opts in', async () => {
    const res = await req('GET', tasksPath(), ownerToken);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).tasks)).toBe(true);
  });

  test('the gate is checked AFTER authz: a non-member gets 403 either way', async () => {
    for (const workspace of [WORKSPACE, WORKSPACE_OFF]) {
      const res = await req('GET', tasksPath(workspace), outsiderToken);
      expect(res.status).toBe(403);
    }
  });

  // The two-workspace cases above compare two rows; this one flips ONE row and
  // asserts both directions on it. That is what catches the gate reading a
  // cached/boot-time feature set instead of the project's current metadata —
  // a bug under which turning `agi` off would leave the surface reachable.
  test('flipping the flag on one project takes effect immediately, both ways', async () => {
    const setAgi = (on: boolean) =>
      db
        .update(projects)
        .set({ metadata: on ? { experimental: { agi: true } } : {} })
        .where(eq(projects.projectId, WORKSPACE_OFF));

    try {
      await setAgi(true);
      const on = await req('GET', tasksPath(WORKSPACE_OFF), ownerToken);
      expect(on.status).toBe(200);

      await setAgi(false);
      const off = await req('GET', tasksPath(WORKSPACE_OFF), ownerToken);
      expect(off.status).toBe(404);
      expect((await off.json()).error).toBe('AGI is not enabled for this project');
    } finally {
      await setAgi(false);
    }
  });
});

describe('create (R-20 idempotency)', () => {
  test('the same origin_fingerprint twice returns the same task and inserts one row', async () => {
    const fingerprint = `fp-${crypto.randomUUID()}`;
    const first = await req('POST', tasksPath(), ownerToken, {
      title: 'trigger fired',
      origin: 'trigger',
      trigger_slug: 'nightly',
      origin_fingerprint: fingerprint,
    });
    const second = await req('POST', tasksPath(), ownerToken, {
      title: 'trigger fired again',
      origin: 'trigger',
      trigger_slug: 'nightly',
      origin_fingerprint: fingerprint,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.created).toBe(true);
    expect(secondBody.created).toBe(false);
    expect(secondBody.task.task_id).toBe(firstBody.task.task_id);
    // The dedupe returns the ORIGINAL row — a second fire must not overwrite it.
    expect(secondBody.task.title).toBe('trigger fired');

    const rows = await db
      .select()
      .from(agiTasks)
      .where(
        and(eq(agiTasks.workspaceId, WORKSPACE), eq(agiTasks.originFingerprint, fingerprint)),
      );
    expect(rows).toHaveLength(1);
  });

  test('two unfingerprinted creates produce two rows', async () => {
    const a = await newTask({ title: 'no fingerprint' });
    const b = await newTask({ title: 'no fingerprint' });
    expect(a.task_id).not.toBe(b.task_id);
  });

  test('two assignees are a 400, never a CHECK-constraint 500 (R-14)', async () => {
    const res = await req('POST', tasksPath(), ownerToken, {
      title: 'double booked',
      origin: 'human',
      agent: 'researcher',
      assignee_user_id: OWNER,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('two_assignees');
  });

  test('an unknown blocker is a 400 with a code', async () => {
    const res = await req('POST', tasksPath(), ownerToken, {
      title: 'dangling',
      origin: 'human',
      blocked_by: [crypto.randomUUID()],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unknown_blocker');
  });

  test('a parent from another workspace does not resolve', async () => {
    const foreign = await newTask({ title: 'foreign parent' }, OTHER_WORKSPACE);
    const res = await req('POST', tasksPath(), ownerToken, {
      title: 'child',
      origin: 'human',
      parent_id: foreign.task_id,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('parent_id does not resolve in this workspace');
  });
});

describe('claim (R-18, R-19)', () => {
  test('two concurrent claims produce exactly one winner and one 409', async () => {
    const task = await newTask({ title: 'two-way race' });
    const responses = await Promise.all([
      req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, { session_id: 'ses_a' }),
      req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, { session_id: 'ses_b' }),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);

    const loser = responses.find((r) => r.status === 409)!;
    const body = await loser.json();
    expect(body.code).toBe('claim_conflict');
    expect(['ses_a', 'ses_b']).toContain(body.claim.session_id);

    const winner = responses.find((r) => r.status === 200)!;
    const won = (await winner.json()).task;
    expect(won.claimed).toBe(true);
    // Whoever the loser reports as holder IS the holder — the diagnostic read
    // must agree with the row the winner got back.
    expect(body.claim.session_id).toBe(won.claim_session_id);
  });

  test('eight concurrent claims still produce exactly one winner', async () => {
    const task = await newTask({ title: 'eight-way race' });
    const sessions = Array.from({ length: 8 }, (_, i) => `ses_race_${i}`);
    const responses = await Promise.all(
      sessions.map((session_id) =>
        req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, { session_id }),
      ),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    const winners = responses.filter((r) => r.status === 200);
    const losers = responses.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(
      bodies.filter((_, i) => responses[i].status === 409).every((b) => b.code === 'claim_conflict'),
    ).toBe(true);

    const [row] = await db
      .select()
      .from(agiTasks)
      .where(eq(agiTasks.taskId, task.task_id));
    const winnerBody = bodies[responses.indexOf(winners[0])];
    expect(row.claimSessionId).toBe(winnerBody.task.claim_session_id);
  });

  test('a re-claim by the SAME session extends the lease instead of conflicting', async () => {
    const task = await newTask({ title: 'heartbeat' });
    const first = await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_live',
      ttl_seconds: 30,
    });
    expect(first.status).toBe(200);
    const firstExpiry = (await first.json()).task.claim_expires_at;

    const second = await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_live',
      ttl_seconds: 900,
    });
    expect(second.status).toBe(200);
    const secondExpiry = (await second.json()).task.claim_expires_at;
    expect(Date.parse(secondExpiry)).toBeGreaterThan(Date.parse(firstExpiry));
  });

  test('a live claim cannot be broken by another session (R-19)', async () => {
    const task = await newTask({ title: 'live holder' });
    await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_holder',
      ttl_seconds: 900,
    });
    const res = await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_thief',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).claim.session_id).toBe('ses_holder');
  });

  test('an expired claim is adoptable by a different session (R-19)', async () => {
    const task = await newTask({ title: 'crashed holder' });
    await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_crashed',
      ttl_seconds: 30,
    });
    // Simulate the crash: the holder never heartbeats and the lease lapses.
    await db
      .update(agiTasks)
      .set({ claimExpiresAt: sql`now() - interval '1 minute'` })
      .where(eq(agiTasks.taskId, task.task_id));

    const res = await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_adopter',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).task.claim_session_id).toBe('ses_adopter');
  });

  test('the claim can move the status in the same statement', async () => {
    const task = await newTask({ title: 'claim into doing' });
    const res = await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_doing',
      status: 'doing',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).task.status).toBe('doing');
  });

  test('a terminal task cannot be claimed', async () => {
    const task = await newTask({ title: 'already done' });
    await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, { status: 'done' });
    const res = await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_late',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('task_terminal');
  });

  test('claiming into a terminal status is a 400', async () => {
    const task = await newTask({ title: 'bad claim status' });
    const res = await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_x',
      status: 'done',
    });
    expect(res.status).toBe(400);
  });
});

describe('release', () => {
  test('only the holder can release', async () => {
    const task = await newTask({ title: 'release me' });
    await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_holder',
    });

    const stranger = await req('POST', `${tasksPath()}/${task.task_id}/release`, ownerToken, {
      session_id: 'ses_stranger',
    });
    expect(stranger.status).toBe(409);
    expect((await stranger.json()).code).toBe('claim_not_held');

    const holder = await req('POST', `${tasksPath()}/${task.task_id}/release`, ownerToken, {
      session_id: 'ses_holder',
      status: 'review',
    });
    expect(holder.status).toBe(200);
    const released = (await holder.json()).task;
    expect(released.claim_session_id).toBeNull();
    expect(released.claimed).toBe(false);
    expect(released.status).toBe('review');
  });
});

describe('patch', () => {
  test('reaching a terminal status clears the claim triple', async () => {
    const task = await newTask({ title: 'finish while claimed' });
    await req('POST', `${tasksPath()}/${task.task_id}/claim`, ownerToken, {
      session_id: 'ses_worker',
    });
    const res = await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, {
      status: 'done',
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()).task;
    expect(patched.status).toBe('done');
    expect(patched.claim_session_id).toBeNull();
    expect(patched.claimed_at).toBeNull();
    expect(patched.claim_expires_at).toBeNull();
  });

  test('both assignees in one patch is a 400, never a 500 (R-14)', async () => {
    const task = await newTask({ title: 'double booked patch' });
    const res = await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, {
      agent: 'researcher',
      assignee_user_id: OWNER,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('two_assignees');
  });

  test('naming an agent moves the assignment off the human', async () => {
    const task = await newTask({ title: 'reassign', assignee_user_id: OWNER });
    const res = await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, {
      agent: 'researcher',
    });
    const patched = (await res.json()).task;
    expect(patched.agent).toBe('researcher');
    expect(patched.assignee_user_id).toBeNull();
  });

  test('an empty body has nothing to update', async () => {
    const task = await newTask({ title: 'empty patch' });
    const res = await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No fields to update');
  });

  test('a server-owned field is rejected by name', async () => {
    const task = await newTask({ title: 'not patchable' });
    const res = await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, {
      claim_session_id: 'ses_sneaky',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('claim_session_id is not patchable');
  });

  test('a parent cycle is refused', async () => {
    const root = await newTask({ title: 'root' });
    const child = await newTask({ title: 'child', parent_id: root.task_id });
    const res = await req('PATCH', `${tasksPath()}/${root.task_id}`, ownerToken, {
      parent_id: child.task_id,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('parent_cycle');
  });

  test('a task cannot block itself', async () => {
    const task = await newTask({ title: 'self blocker' });
    const res = await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, {
      blocked_by: [task.task_id],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('self_blocker');
  });

  test('blocked_by is replaced wholesale, not merged', async () => {
    const first = await newTask({ title: 'blocker one' });
    const second = await newTask({ title: 'blocker two' });
    const task = await newTask({ title: 'blocked', blocked_by: [first.task_id] });

    const res = await req('PATCH', `${tasksPath()}/${task.task_id}`, ownerToken, {
      blocked_by: [second.task_id],
    });
    expect((await res.json()).task.blocked_by).toEqual([second.task_id]);
  });
});

describe('read', () => {
  test('a cancelled blocker keeps the edge and is still returned (R-17)', async () => {
    const blocker = await newTask({ title: 'will be cancelled' });
    await req('PATCH', `${tasksPath()}/${blocker.task_id}`, ownerToken, { status: 'cancelled' });
    const task = await newTask({ title: 'waiting', blocked_by: [blocker.task_id] });

    const res = await req('GET', `${tasksPath()}/${task.task_id}`, ownerToken);
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.task.blocked_by).toEqual([blocker.task_id]);
    expect(detail.blockers).toHaveLength(1);
    expect(detail.blockers[0].status).toBe('cancelled');
    expect(detail.missing_blockers).toEqual([]);
  });

  test('children come back on the parent, and blockers keep blocked_by order', async () => {
    const a = await newTask({ title: 'blocker a' });
    const b = await newTask({ title: 'blocker b' });
    const parent = await newTask({ title: 'parent', blocked_by: [b.task_id, a.task_id] });
    const child = await newTask({ title: 'child', parent_id: parent.task_id });

    const detail = await (await req('GET', `${tasksPath()}/${parent.task_id}`, ownerToken)).json();
    expect(detail.blockers.map((t: any) => t.task_id)).toEqual([b.task_id, a.task_id]);
    expect(detail.children.map((t: any) => t.task_id)).toEqual([child.task_id]);
  });

  test('a task from another workspace is a 404, not a 403', async () => {
    const foreign = await newTask({ title: 'not yours' }, OTHER_WORKSPACE);
    const res = await req('GET', `${tasksPath()}/${foreign.task_id}`, ownerToken);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  test('a non-uuid task id is a 404, not a 22P02 500', async () => {
    const res = await req('GET', `${tasksPath()}/not-a-uuid`, ownerToken);
    expect(res.status).toBe(404);
  });

  test('the default list is open work only; status=all includes terminal rows', async () => {
    const done = await newTask({ title: 'closed out' });
    await req('PATCH', `${tasksPath()}/${done.task_id}`, ownerToken, { status: 'done' });

    const open = await (await req('GET', tasksPath(), ownerToken)).json();
    expect(open.tasks.some((t: any) => t.task_id === done.task_id)).toBe(false);

    const all = await (await req('GET', `${tasksPath()}?status=all&limit=200`, ownerToken)).json();
    expect(all.tasks.some((t: any) => t.task_id === done.task_id)).toBe(true);
  });

  test('filters narrow to the goal and the assignee', async () => {
    const goal = `goal-${crypto.randomUUID().slice(0, 8)}`;
    const mine = await newTask({ title: 'goal work', goal_slug: goal, agent: 'researcher' });
    await newTask({ title: 'other work' });

    const byGoal = await (await req('GET', `${tasksPath()}?goal=${goal}`, ownerToken)).json();
    expect(byGoal.tasks.map((t: any) => t.task_id)).toEqual([mine.task_id]);

    const byAgent = await (
      await req('GET', `${tasksPath()}?goal=${goal}&assignee=agent:researcher`, ownerToken)
    ).json();
    expect(byAgent.tasks.map((t: any) => t.task_id)).toEqual([mine.task_id]);

    const byUser = await (
      await req('GET', `${tasksPath()}?goal=${goal}&assignee=user:${OWNER}`, ownerToken)
    ).json();
    expect(byUser.tasks).toEqual([]);
  });

  test('the cursor walks pages without repeating a row', async () => {
    const goal = `page-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i += 1) await newTask({ title: `page ${i}`, goal_slug: goal });

    const first = await (await req('GET', `${tasksPath()}?goal=${goal}&limit=2`, ownerToken)).json();
    expect(first.tasks).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = await (
      await req(
        'GET',
        `${tasksPath()}?goal=${goal}&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
        ownerToken,
      )
    ).json();
    expect(second.tasks).toHaveLength(1);
    expect(second.next_cursor).toBeNull();

    const ids = [...first.tasks, ...second.tasks].map((t: any) => t.task_id);
    expect(new Set(ids).size).toBe(3);
  });

  test.each([
    ['status=shipped', 'Invalid status'],
    ['limit=201', 'Invalid limit'],
    ['assignee=researcher', 'Invalid assignee'],
    ['claim=expired', 'Invalid claim'],
    ['cursor=zzz', 'Invalid cursor'],
    ['parent=nope', 'Invalid parent'],
    ['blocked_by=nope', 'Invalid blocked_by'],
  ])('%s is a 400', async (query, message) => {
    const res = await req('GET', `${tasksPath()}?${query}`, ownerToken);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
  });
});
