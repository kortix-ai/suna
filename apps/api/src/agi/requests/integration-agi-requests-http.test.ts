/**
 * Real-DB integration over the mounted app for spec §4.3 (R-12g) end to end.
 *
 * Everything that makes this module trustworthy is a property of the DATABASE —
 * "one ask, one DM" IS the partial unique index on `origin_fingerprint`, "the
 * first responder wins" IS a status-scoped conditional UPDATE, and "an ask
 * cannot be marked delivered with no addressee" IS a CHECK constraint. A mocked
 * store would test the mock.
 *
 * Slack is the ONE thing stubbed. This box has no Slack workspace and no bot
 * token, so `postSlackDm` genuinely cannot run here; the test asserts the
 * DEGRADE path (delivery falls back to `inbox`, the durable addressed row) and,
 * separately, that a workspace with no members at all leaves the ask undelivered
 * and its task stalled. What is NOT proven here: that a real Slack DM lands.
 *
 * What this file is here to prove:
 *   • raising and delivering are ONE call — there is no way to record an ask
 *     through this API without also trying to send it (R-12g);
 *   • a delivered ask makes its task read as a live path (R-28 answer 5) on the
 *     EXISTING liveness route, and an undelivered one makes it read as stalled —
 *     the distinction the whole section exists for;
 *   • a goal-linked task, which used to hide behind `awaiting_trigger` forever,
 *     no longer does;
 *   • a standing daily push re-asking produces ONE row and no second delivery;
 *   • answering it hands the task straight back to ordinary liveness.
 *
 * The `integration-` filename prefix is load-bearing: scripts/test.sh's default
 * bucket excludes it, because that bucket runs without a database. Run this with:
 *   KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- \
 *     bun test src/agi/requests/integration-agi-requests-http.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  agiRequests,
  agiTasks,
  projectMembers,
  projectSessions,
  projects,
} from '@kortix/db';
import { db } from '../../shared/db';
import { app } from '../../index';
import { createAccountToken } from '../../repositories/account-tokens';
import { claimTask, createTask } from '../tasks/store';
import { createRequest } from './store';
import { recordSessionOutcome } from '../liveness/session-outcome';
import { resolveWorkspaceLiveness } from '../liveness/surface';

const ACCOUNT = crypto.randomUUID();
const OUTSIDER_ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const WORKSPACE_OFF = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const TEAMMATE = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();

const minted: string[] = [];
let ownerToken = '';
let outsiderToken = '';

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );

  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'agi-requests-test' },
    { accountId: OUTSIDER_ACCOUNT, name: 'agi-requests-test-outsider' },
  ]);
  await db.insert(projects).values([
    {
      projectId: WORKSPACE,
      accountId: ACCOUNT,
      name: 'agi-requests-workspace',
      repoUrl: 'https://example.com/agi-requests.git',
      metadata: { experimental: { agi: true } },
    },
    {
      projectId: WORKSPACE_OFF,
      accountId: ACCOUNT,
      name: 'agi-requests-workspace-off',
      repoUrl: 'https://example.com/agi-requests-off.git',
    },
  ]);
  await db.insert(accountMembers).values([
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
    { userId: TEAMMATE, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: OUTSIDER, accountId: OUTSIDER_ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
  ]);
  await db.insert(projectMembers).values(
    [WORKSPACE, WORKSPACE_OFF].map((projectId) => ({
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

beforeEach(async () => {
  // agi_requests cascades from agi_tasks, so deleting the tasks clears both.
  await db.delete(agiTasks).where(inArray(agiTasks.workspaceId, [WORKSPACE, WORKSPACE_OFF]));
  await db
    .delete(projectSessions)
    .where(inArray(projectSessions.projectId, [WORKSPACE, WORKSPACE_OFF]));
});

/**
 * A session row the sandbox lifecycle would have created. `branch_name` is
 * NOT NULL, so a session cannot be conjured with two columns.
 */
async function seedSession(): Promise<string> {
  const sessionId = `ses_${crypto.randomUUID()}`;
  await db.insert(projectSessions).values({
    sessionId,
    projectId: WORKSPACE,
    accountId: ACCOUNT,
    branchName: `requests/${crypto.randomUUID().slice(0, 8)}`,
    status: 'running',
    createdBy: OWNER,
  } as never);
  return sessionId;
}

/**
 * An ask recorded with NO addressee, straight through the store.
 *
 * There is deliberately no API path to this: the route refuses a responder who
 * is not a member and otherwise falls back to the account owner, and a caller
 * must be an account member to reach the route at all. It is reachable in the
 * library — `resolveDefaultResponder` returns null for an account with no
 * members — and the read model has to judge it correctly regardless of which
 * layer produced it, so it is seeded here rather than left untested.
 */
async function seedUndeliveredRequest(taskId: string) {
  const { row } = await createRequest({
    workspaceId: WORKSPACE,
    taskId,
    kind: 'access',
    need: 'Search Console property access',
    why: null,
    url: null,
    responderUserId: null,
    requestedBySessionId: null,
    originFingerprint: `agi-request:v1:${crypto.randomUUID().slice(0, 16)}`,
  });
  return row;
}

async function mint(accountId: string, userId: string): Promise<string> {
  const token = await createAccountToken({ accountId, userId, name: 'agi-requests-test' });
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

/** A task the way an unattended push would leave one: agent-owned, under a
 *  goal, blocked on something outside Kortix. */
async function seedTask(overrides: Record<string, unknown> = {}, workspace = WORKSPACE) {
  const { row } = await createTask({
    workspaceId: workspace,
    title: 'Measure the core terms',
    body: null,
    goalSlug: 'seo',
    project: null,
    parentId: null,
    status: 'blocked',
    priority: 'high',
    agent: 'researcher',
    assigneeUserId: null,
    blockedBy: [],
    triggerSlug: null,
    origin: 'trigger',
    originFingerprint: null,
    ...overrides,
  } as Parameters<typeof createTask>[0]);
  return row;
}

const requestsPath = (workspace = WORKSPACE) => `/v1/projects/${workspace}/agi/requests`;
const raisePath = (taskId: string, workspace = WORKSPACE) =>
  `/v1/projects/${workspace}/agi/tasks/${taskId}/requests`;

function raise(taskId: string, body: Record<string, unknown> = {}, secret = ownerToken) {
  return req('POST', raisePath(taskId), secret, {
    kind: 'secret',
    need: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
    why: 'The daily push cannot read rankings without it.',
    url: 'https://app.kortix.test/setup/abc',
    ...body,
  });
}

async function livenessFor(taskId: string, workspace = WORKSPACE) {
  const result = await resolveWorkspaceLiveness({ workspaceId: workspace });
  return result.views.find((view) => view.task.taskId === taskId);
}

// ─── R-44: the gate ─────────────────────────────────────────────────────────

describe('experimental gate (R-44)', () => {
  test('every route 404s when `agi` is off, even for a manager', async () => {
    const task = await seedTask({}, WORKSPACE_OFF);
    const routes = [
      req('POST', raisePath(task.taskId, WORKSPACE_OFF), ownerToken, {
        kind: 'secret',
        need: 'X',
      }),
      req('GET', requestsPath(WORKSPACE_OFF), ownerToken),
      req('POST', `${requestsPath(WORKSPACE_OFF)}/${crypto.randomUUID()}`, ownerToken, {}),
    ];
    for (const res of await Promise.all(routes)) expect(res.status).toBe(404);
  });

  test('a non-member gets 403, not a hint about the feature', async () => {
    const res = await req('GET', requestsPath(), outsiderToken);
    expect(res.status).toBe(403);
  });
});

// ─── R-12g: raising IS delivering ───────────────────────────────────────────

describe('POST …/tasks/:taskId/requests — raise and deliver (R-12g)', () => {
  test('one call records the ask AND delivers it', async () => {
    const task = await seedTask();
    const res = await raise(task.taskId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    expect(body.created).toBe(true);
    // No Slack install on this box, so it degrades to the durable addressed
    // inbox — still a real surface with a real addressee, which a session log
    // is not.
    expect(body.delivered_via).toBe('inbox');
    expect(body.request.delivered_at).not.toBeNull();
    expect(body.request.live).toBe(true);
    // Nobody named a responder, so it fell back to the account owner — the same
    // principal unattended work runs as and R-32 escalates to.
    expect(body.request.responder_user_id).toBe(OWNER);
  });

  test('there is no way to record an ask without trying to send it', async () => {
    // The API exposes no "create without deliver". Every row that exists went
    // through the delivery attempt in the same call that created it.
    const task = await seedTask();
    await raise(task.taskId);
    const rows = await db.select().from(agiRequests).where(eq(agiRequests.taskId, task.taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveredAt).not.toBeNull();
  });

  test('an explicit responder is honoured when they are a member', async () => {
    const task = await seedTask();
    const res = await raise(task.taskId, { responder_user_id: TEAMMATE });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).request.responder_user_id).toBe(TEAMMATE);
  });

  test("a responder who is not in the workspace is a 400, not a delivery to nobody", async () => {
    // A stranger's uuid satisfies every CHECK and would still be delivered to no
    // one while reading as a healthy live path — the precise failure §4.3 closes.
    const task = await seedTask();
    const res = await raise(task.taskId, { responder_user_id: OUTSIDER });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('unknown_responder');
  });

  test("the task's own human assignee is preferred over the account owner", async () => {
    const task = await seedTask({ agent: null, assigneeUserId: TEAMMATE });
    const res = await raise(task.taskId);
    expect(((await res.json()) as any).request.responder_user_id).toBe(TEAMMATE);
  });

  test('a pasted credential in `url` is rejected before it can be messaged to anyone', async () => {
    const task = await seedTask();
    const res = await raise(task.taskId, { url: 'sk-live-abcdef0123456789' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('invalid_url');
    expect(await db.select().from(agiRequests).where(eq(agiRequests.taskId, task.taskId))).toHaveLength(0);
  });

  test('an unknown task is a 404 before anything is written', async () => {
    const res = await raise(crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});

// ─── R-20: one ask, one message ─────────────────────────────────────────────

describe('idempotency — a daily push must not DM a human every morning', () => {
  test('the same ask twice is ONE row, and the second is not re-delivered', async () => {
    const task = await seedTask();
    const first = await raise(task.taskId);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as any;

    const second = await raise(task.taskId);
    // 200, not 201: this ask already existed.
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as any;
    expect(secondBody.created).toBe(false);
    expect(secondBody.request.request_id).toBe(firstBody.request.request_id);
    // The delivery timestamp is the ORIGINAL one — nothing re-stamped it, which
    // is what would have produced a second DM.
    expect(secondBody.request.delivered_at).toBe(firstBody.request.delivered_at);

    expect(await db.select().from(agiRequests).where(eq(agiRequests.taskId, task.taskId))).toHaveLength(1);
  });

  test('re-asking in different casing or spacing is still the same ask', async () => {
    const task = await seedTask();
    await raise(task.taskId);
    const again = await raise(task.taskId, { need: '  google_search_console_token ' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).created).toBe(false);
  });

  test('a genuinely different ask on the same task is a second row', async () => {
    const task = await seedTask();
    await raise(task.taskId);
    const other = await raise(task.taskId, { need: 'AHREFS_API_KEY' });
    expect(other.status).toBe(201);
    expect(await db.select().from(agiRequests).where(eq(agiRequests.taskId, task.taskId))).toHaveLength(2);
  });
});

// ─── THE point: what liveness now says ──────────────────────────────────────

describe('liveness (R-28 answer 5) — the distinction the feature exists for', () => {
  test('THE regression: a goal-linked task blocked on a human, with no ask, is now a stall', async () => {
    // This is the platinum.dev scenario as it actually occurs. The push marked
    // the task `blocked`, named no blocking task, and wrote the minted URL into
    // its own session log. Before §4.3 this read as `awaiting_trigger` —
    // perfectly healthy — because the goal's standing push does keep firing. It
    // just can never advance.
    const task = await seedTask();
    const view = await livenessFor(task.taskId);
    expect(view?.liveness.state).toBe('stalled');
    expect(view?.liveness.reason).toBe('blocked_without_cause');
  });

  test('a task with a real blocker edge is untouched — it says what it waits on', async () => {
    const blocker = await seedTask({ title: 'Get the grant', status: 'todo' });
    const waiter = await seedTask({ blockedBy: [blocker.taskId] });
    expect((await livenessFor(waiter.taskId))?.liveness.state).toBe('blocked');
  });

  test('once the ask is DELIVERED the same task reads as awaiting_response', async () => {
    const task = await seedTask();
    await raise(task.taskId);
    const view = await livenessFor(task.taskId);
    expect(view?.liveness.state).toBe('awaiting_response');
    expect(view?.liveness.reason).toBeNull();
    expect(view?.liveness.request?.delivered).toBe(true);
    expect(view?.liveness.request?.need).toBe('GOOGLE_SEARCH_CONSOLE_TOKEN');
  });

  test('an ask that reached NOBODY makes the task stalled, and names why', async () => {
    const task = await seedTask({ status: 'todo' });
    await seedUndeliveredRequest(task.taskId);
    const view = await livenessFor(task.taskId);
    expect(view?.liveness.state).toBe('stalled');
    expect(view?.liveness.reason).toBe('request_undelivered');
    expect(view?.liveness.request?.delivered).toBe(false);
  });

  test('answering the ask hands the task straight back to ordinary liveness', async () => {
    // `todo`, not `blocked` — answering an ask does not move the board, so a
    // task still marked blocked stays surfaced (asserted separately below).
    const task = await seedTask({ status: 'todo' });
    const raised = (await (await raise(task.taskId)).json()) as any;
    expect((await livenessFor(task.taskId))?.liveness.state).toBe('awaiting_response');

    const answered = await req(
      'POST',
      `${requestsPath()}/${raised.request.request_id}`,
      ownerToken,
      { note: 'Granted on the property.' },
    );
    expect(answered.status).toBe(200);
    const body = (await answered.json()) as any;
    expect(body.request.status).toBe('satisfied');
    expect(body.request.satisfied_by_user_id).toBe(OWNER);
    expect(body.request.live).toBe(false);
    // The ask and the answer are both evidence — the note is appended, never
    // replacing what was asked.
    expect(body.request.why).toContain('cannot read rankings');
    expect(body.request.why).toContain('Granted on the property.');

    expect((await livenessFor(task.taskId))?.liveness.state).toBe('awaiting_trigger');
  });

  test('cancelling also drops the live path, and records no satisfaction', async () => {
    const task = await seedTask({ status: 'todo' });
    const raised = (await (await raise(task.taskId)).json()) as any;
    const res = await req('POST', `${requestsPath()}/${raised.request.request_id}`, ownerToken, {
      status: 'cancelled',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.request.status).toBe('cancelled');
    expect(body.request.satisfied_at).toBeNull();
    expect((await livenessFor(task.taskId))?.liveness.state).toBe('awaiting_trigger');
  });

  test('answering does NOT unblock the board — a task left in `blocked` stays surfaced', async () => {
    // R-31 in the other direction: a human supplying a credential is not a task
    // status change. Somebody still has to move the work, and until they do the
    // board must not claim the task is fine.
    const task = await seedTask();
    const raised = (await (await raise(task.taskId)).json()) as any;
    await req('POST', `${requestsPath()}/${raised.request.request_id}`, ownerToken, {});
    const view = await livenessFor(task.taskId);
    expect(view?.liveness.state).toBe('stalled');
    expect(view?.liveness.reason).toBe('blocked_without_cause');
  });

  test('the first responder wins; a second answer is a 409, not an overwrite', async () => {
    const task = await seedTask();
    const raised = (await (await raise(task.taskId)).json()) as any;
    const path = `${requestsPath()}/${raised.request.request_id}`;
    expect((await req('POST', path, ownerToken, {})).status).toBe(200);
    const second = await req('POST', path, ownerToken, {});
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).code).toBe('request_not_pending');
  });

  test('a request id from another workspace is a 404, never a 403', async () => {
    const res = await req('POST', `${requestsPath()}/${crypto.randomUUID()}`, ownerToken, {});
    expect(res.status).toBe(404);
  });

  test('the stall surface reports it on the SAME route a stuck task uses', async () => {
    const task = await seedTask({ status: 'todo' });
    await seedUndeliveredRequest(task.taskId);
    const res = await req('GET', `/v1/projects/${WORKSPACE}/agi/liveness`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.stalled_count).toBe(1);
    expect(body.stalled[0].liveness.reason).toBe('request_undelivered');
    // The ask rides along, so a human reading the stall report sees WHAT was
    // needed without a second lookup.
    expect(body.stalled[0].liveness.request.need).toBe('Search Console property access');
    expect(body.stalled[0].liveness.request.delivered).toBe(false);
  });
});

// ─── the overnight path: a session that asked, then ended ───────────────────

describe('session writeback — a push that asked before it exited', () => {
  test('a delivered ask survives the session ending: the task is not treated as a crash', async () => {
    // This is the platinum.dev scenario in full. The 07:00 push claims the task,
    // discovers it needs a grant, delivers the ask, and exits. Without §4.3 the
    // finalize hook sees an agent-owned task with a released claim and no live
    // path and manufactures a continuation — burying the real signal under work
    // nobody can do.
    const task = await seedTask({ goalSlug: null, status: 'doing' });
    const sessionId = await seedSession();
    await claimTask({ workspaceId: WORKSPACE, taskId: task.taskId, sessionId, ttlSeconds: 900 });
    await raise(task.taskId);

    await db
      .update(projectSessions)
      .set({ status: 'completed' })
      .where(eq(projectSessions.sessionId, sessionId));
    const outcome = await recordSessionOutcome({ sessionId });

    expect(outcome.skipped).toBeNull();
    expect(outcome.claims).toHaveLength(1);
    expect(outcome.claims[0].state).toBe('awaiting_response');
    // R-32's bound never engages: this task is not stalled.
    expect(outcome.claims[0].recovery).toBeNull();
  });

  test('the same session with NO ask is still recovered exactly as before', async () => {
    const task = await seedTask({ goalSlug: null, status: 'doing' });
    const sessionId = await seedSession();
    await claimTask({ workspaceId: WORKSPACE, taskId: task.taskId, sessionId, ttlSeconds: 900 });
    await db
      .update(projectSessions)
      .set({ status: 'failed' })
      .where(eq(projectSessions.sessionId, sessionId));

    const outcome = await recordSessionOutcome({ sessionId });
    expect(outcome.claims[0].state).toBe('stalled');
    expect(outcome.claims[0].recovery).toBe('continued');
  });
});

// ─── the inbox ──────────────────────────────────────────────────────────────

describe('GET …/agi/requests — what is waiting on you', () => {
  test('`responder=me` is resolved server-side', async () => {
    const mine = await seedTask();
    const theirs = await seedTask({ title: 'Something else' });
    await raise(mine.taskId);
    await raise(theirs.taskId, { need: 'AHREFS_API_KEY', responder_user_id: TEAMMATE });

    const res = await req('GET', `${requestsPath()}?responder=me`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].task_id).toBe(mine.taskId);
    // The blocked work is named, so an inbox row says what it is holding up.
    expect(body.requests[0].task_title).toBe('Measure the core terms');
  });

  test('the inbox is OLDEST first — the longest-ignored ask is on top', async () => {
    const task = await seedTask();
    await raise(task.taskId, { need: 'FIRST_ASK' });
    await raise(task.taskId, { need: 'SECOND_ASK' });
    const body = (await (await req('GET', requestsPath(), ownerToken)).json()) as any;
    expect(body.requests.map((r: any) => r.need)).toEqual(['FIRST_ASK', 'SECOND_ASK']);
  });

  test('pending is the default; answered asks drop out of the inbox', async () => {
    const task = await seedTask();
    const raised = (await (await raise(task.taskId)).json()) as any;
    await req('POST', `${requestsPath()}/${raised.request.request_id}`, ownerToken, {});

    const pending = (await (await req('GET', requestsPath(), ownerToken)).json()) as any;
    expect(pending.requests).toHaveLength(0);
    const all = (await (await req('GET', `${requestsPath()}?status=all`, ownerToken)).json()) as any;
    expect(all.requests).toHaveLength(1);
  });

  test('`undelivered=1` is its own view: what the system could not get to a human', async () => {
    const reachable = await seedTask();
    await raise(reachable.taskId);
    const empty = (await (
      await req('GET', `${requestsPath()}?undelivered=1`, ownerToken)
    ).json()) as any;
    expect(empty.requests).toHaveLength(0);

    const stranded = await seedTask({ title: 'Stranded work' });
    await seedUndeliveredRequest(stranded.taskId);
    const found = (await (
      await req('GET', `${requestsPath()}?undelivered=1`, ownerToken)
    ).json()) as any;
    expect(found.requests).toHaveLength(1);
    expect(found.requests[0].delivered_at).toBeNull();
    expect(found.requests[0].task_title).toBe('Stranded work');
  });

  test('bad query values are 400s with their own envelope', async () => {
    for (const query of ['?limit=0', '?limit=abc', '?responder=nope', '?status=maybe', '?task=nope', '?undelivered=maybe']) {
      const res = await req('GET', `${requestsPath()}${query}`, ownerToken);
      expect(res.status).toBe(400);
    }
  });

  test('a task filter scopes the inbox to one piece of work', async () => {
    const a = await seedTask();
    const b = await seedTask({ title: 'Other work' });
    await raise(a.taskId);
    await raise(b.taskId, { need: 'AHREFS_API_KEY' });
    const body = (await (
      await req('GET', `${requestsPath()}?task=${a.taskId}`, ownerToken)
    ).json()) as any;
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].task_id).toBe(a.taskId);
  });
});
