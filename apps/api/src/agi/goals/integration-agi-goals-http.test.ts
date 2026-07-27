/**
 * Real-DB integration over the mounted app for `kortix goals ls|show|push`.
 *
 * Goals are not a table — they are read out of `kortix.yaml` on every request —
 * so the git read is the only thing stubbed here (`readManifestFromRepo`), the
 * same seam ../../projects/lib/triggers.test.ts uses. Everything downstream of
 * it is real: the manifest parser, the goal→trigger desugaring, the task rollup
 * against `agi_tasks`, and the authz prelude.
 *
 * `fireGitTrigger` is stubbed too, and deliberately: `push` must DELEGATE to the
 * existing manual trigger-fire path rather than re-implement it, and the only
 * way to assert that is to capture the spec it hands over. Actually firing would
 * mint a session and a sandbox.
 *
 * The `integration-` filename prefix is load-bearing: scripts/test.sh's default
 * bucket excludes it, because that bucket runs without a database. Run this with:
 *   KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- \
 *     bun test src/agi/goals/integration-agi-goals-http.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/** Swapped per test — this is "what kortix.yaml says right now". */
let manifestFile: { path: string; content: string } | null = null;
let fired: Array<Record<string, any>> = [];
let fireResult: Record<string, any> = { status: 'fired', sessionId: null, deduped: false };

// Spread-and-override, never replace: these are heavily-imported modules and the
// rest of the app's import graph needs their other named exports intact.
const realProjectsGit = await import('../../projects/git');
mock.module('../../projects/git', () => ({
  ...realProjectsGit,
  readManifestFromRepo: async (_project: unknown, candidates: string[]) =>
    manifestFile && candidates.includes(manifestFile.path) ? manifestFile : null,
}));

const realLibGit = await import('../../projects/lib/git');
mock.module('../../projects/lib/git', () => ({
  ...realLibGit,
  withProjectGitAuth: async (project: unknown) => ({
    ...(project as Record<string, unknown>),
    gitAuthToken: null,
    gitAuthHeaders: {},
  }),
}));

const realLibTriggers = await import('../../projects/lib/triggers');
mock.module('../../projects/lib/triggers', () => ({
  ...realLibTriggers,
  fireGitTrigger: async (input: Record<string, any>) => {
    fired.push(input);
    return fireResult;
  },
}));

const { and, eq, inArray, sql } = await import('drizzle-orm');
const { accountMembers, accounts, agiTasks, projectMembers, projects } = await import('@kortix/db');
const { db } = await import('../../shared/db');
const { app } = await import('../../index');
const { createAccountToken } = await import('../../repositories/account-tokens');

const ACCOUNT = crypto.randomUUID();
const OUTSIDER_ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const WORKSPACE_OFF = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();

const minted: string[] = [];
let ownerToken = '';
let outsiderToken = '';

const MANIFEST = `kortix_version: 2

goals:
  - slug: oil-desk
    title: Oil trades running 24/7
    done_when: A live account runs the strategy unattended for 7 days.
    status: active
    push: "0 0 9 * * *"

  - slug: hire-ops
    title: Ops lead hired
    done_when: An offer is signed and a start date is on the calendar.
    status: paused
    push: "0 0 10 * * *"

  - slug: on-demand
    title: Advanced only when asked
    done_when: Someone says so.
`;

const yaml = (content: string) => ({ path: 'kortix.yaml', content });

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );

  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'agi-goals-test' },
    { accountId: OUTSIDER_ACCOUNT, name: 'agi-goals-test-outsider' },
  ]);
  await db.insert(projects).values([
    {
      projectId: WORKSPACE,
      accountId: ACCOUNT,
      name: 'agi-goals-test-workspace',
      repoUrl: 'https://example.com/agi-goals-test.git',
      manifestPath: 'kortix.yaml',
      metadata: { experimental: { agi: true } },
    },
    {
      projectId: WORKSPACE_OFF,
      accountId: ACCOUNT,
      name: 'agi-goals-test-workspace-off',
      repoUrl: 'https://example.com/agi-goals-test-off.git',
      manifestPath: 'kortix.yaml',
    },
  ]);
  await db.insert(accountMembers).values([
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
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

beforeEach(() => {
  manifestFile = yaml(MANIFEST);
  fired = [];
  fireResult = { status: 'fired', sessionId: null, deduped: false };
});

async function mint(accountId: string, userId: string): Promise<string> {
  const token = await createAccountToken({ accountId, userId, name: 'agi-goals-test' });
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

const goalsPath = (workspace = WORKSPACE) => `/v1/projects/${workspace}/agi/goals`;

/** Issues that REJECTED a goal, as opposed to advisories on one that parsed and
 *  is in `goals`. Both ride `errors` on purpose — one channel a surface can
 *  forget to render — so a test about rejection says which half it means. */
const rejected = (issues: any[]) =>
  issues.filter((issue) => !String(issue.message).startsWith('Warning:'));

async function seedTask(goalSlug: string | null, status: string) {
  const [row] = await db
    .insert(agiTasks)
    .values({
      workspaceId: WORKSPACE,
      title: `task for ${goalSlug ?? 'nothing'}`,
      status,
      priority: 'medium',
      origin: 'agi',
      goalSlug,
    })
    .returning();
  return row;
}

describe('experimental gate (R-44)', () => {
  const routes: Array<{ name: string; method: string; suffix: string; body?: unknown }> = [
    { name: 'ls', method: 'GET', suffix: '' },
    { name: 'show', method: 'GET', suffix: '/oil-desk' },
    { name: 'push', method: 'POST', suffix: '/oil-desk/push', body: { reason: null } },
  ];

  test.each(routes)('$name 404s when the project has not enabled agi', async (route) => {
    const res = await req(
      route.method,
      `${goalsPath(WORKSPACE_OFF)}${route.suffix}`,
      ownerToken,
      route.body,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('AGI is not enabled for this project');
  });

  test.each(routes)('$name checks the gate AFTER authz — a non-member gets 403', async (route) => {
    for (const workspace of [WORKSPACE, WORKSPACE_OFF]) {
      const res = await req(
        route.method,
        `${goalsPath(workspace)}${route.suffix}`,
        outsiderToken,
        route.body,
      );
      expect(res.status).toBe(403);
    }
  });
});

describe('GET /agi/goals', () => {
  test('lists goals in manifest declaration order, never sorted (R-10)', async () => {
    const res = await req('GET', goalsPath(), ownerToken);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.goals.map((goal: any) => goal.slug)).toEqual([
      'oil-desk',
      'hire-ops',
      'on-demand',
    ]);
    // Nothing here was REJECTED. `on-demand`'s "Someone says so." earns an
    // advisory (a `done_when` that thin is what an unquoted-"#" truncation looks
    // like), and an advisory rides the same list on purpose — one channel a
    // surface can forget to render.
    expect(rejected(body.errors)).toEqual([]);
  });

  test('carries the derived trigger slug, the push schedule, and done_when', async () => {
    const res = await req('GET', goalsPath(), ownerToken);
    const [oil, , onDemand] = (await res.json()).goals;

    expect(oil.push).toBe('0 0 9 * * *');
    expect(oil.trigger_slug).toBe('goal-oil-desk');
    expect(oil.done_when).toBe('A live account runs the strategy unattended for 7 days.');
    expect(oil.agent).toBe('kortix-agi');

    // No push means no trigger — which is exactly why `goals push` on it is a
    // conflict rather than a fire.
    expect(onDemand.push).toBeNull();
    expect(onDemand.trigger_slug).toBeNull();
  });

  test('joins open/blocked/done counts from agi_tasks by goal_slug', async () => {
    const seeded = await Promise.all([
      seedTask('oil-desk', 'doing'),
      seedTask('oil-desk', 'blocked'),
      seedTask('oil-desk', 'done'),
      seedTask('oil-desk', 'cancelled'),
      // Another goal's work, and unassigned work, must not leak into the tally.
      seedTask('hire-ops', 'todo'),
      seedTask(null, 'todo'),
    ]);
    try {
      const res = await req('GET', goalsPath(), ownerToken);
      const [oil, hire, onDemand] = (await res.json()).goals;

      expect(oil.task_counts).toMatchObject({ doing: 1, blocked: 1, done: 1, cancelled: 1 });
      // Terminal statuses are counted but never open.
      expect(oil.open_task_count).toBe(2);
      expect(hire.open_task_count).toBe(1);
      expect(onDemand.open_task_count).toBe(0);
      expect(onDemand.task_counts.backlog).toBe(0);
    } finally {
      await db.delete(agiTasks).where(
        inArray(
          agiTasks.taskId,
          seeded.map((row) => row.taskId),
        ),
      );
    }
  });

  test('?status filters goals, and an unknown status is a 400', async () => {
    const paused = await req('GET', `${goalsPath()}?status=paused`, ownerToken);
    expect(paused.status).toBe(200);
    expect((await paused.json()).goals.map((goal: any) => goal.slug)).toEqual(['hire-ops']);

    const bad = await req('GET', `${goalsPath()}?status=open`, ownerToken);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Invalid status');
  });

  // The defect this closes: `extractGoals` reports a malformed entry, but the
  // trigger desugaring drops those errors, so before this route a goal with a
  // missing `done_when` was invisible in every surface — it simply was not there.
  test('a malformed goal is REPORTED with its ordinal, not silently omitted', async () => {
    manifestFile = yaml(`kortix_version: 2

goals:
  - slug: fine
    done_when: Done.
  - slug: wishful
    title: No completion criteria
`);
    const res = await req('GET', goalsPath(), ownerToken);
    const body = await res.json();

    expect(body.goals.map((goal: any) => goal.slug)).toEqual(['fine']);
    expect(rejected(body.errors)).toHaveLength(1);
    expect(rejected(body.errors)[0].index).toBe(1);
    expect(rejected(body.errors)[0].slug).toBe('wishful');
    expect(rejected(body.errors)[0].message).toContain('done_when');
  });

  // The `#` footgun, on the surface a human actually reads. `title: ranks #1` is
  // a comment to YAML, so the value arrives already truncated and `errors` used
  // to come back empty — a goal silently reduced to one word with nothing said.
  test('a truncated goal string is WARNED about in the same list `kortix goals ls` reads', async () => {
    manifestFile = yaml(`kortix_version: 2

goals:
  - slug: seo
    title: ranks #1 on Google
    done_when: rank #1 within 90 days
`);
    const res = await req('GET', goalsPath(), ownerToken);
    const body = await res.json();

    // Proof the truncation already happened before anything could see it.
    expect(body.goals[0].title).toBe('ranks');
    expect(body.goals[0].done_when).toBe('rank');
    // Nothing was rejected — the goal works, and the complaint is visible.
    expect(rejected(body.errors)).toEqual([]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].slug).toBe('seo');
    expect(body.errors[0].message).toContain('done_when');
  });

  test('a status filter never hides the errors — a broken goal has no status to filter on', async () => {
    manifestFile = yaml(`kortix_version: 2

goals:
  - slug: wishful
    title: No completion criteria
`);
    const res = await req('GET', `${goalsPath()}?status=active`, ownerToken);
    const body = await res.json();

    expect(body.goals).toEqual([]);
    expect(body.errors).toHaveLength(1);
  });

  test('a project with no manifest has no goals and no complaint', async () => {
    manifestFile = null;
    const res = await req('GET', goalsPath(), ownerToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ goals: [], errors: [] });
  });
});

describe('GET /agi/goals/:slug', () => {
  test('404s for a slug the manifest does not declare', async () => {
    const res = await req('GET', `${goalsPath()}/nope`, ownerToken);
    expect(res.status).toBe(404);
  });

  test('returns the goal, its OPEN tasks only, and its derived trigger', async () => {
    const seeded = await Promise.all([
      seedTask('oil-desk', 'doing'),
      seedTask('oil-desk', 'done'),
    ]);
    try {
      const res = await req('GET', `${goalsPath()}/oil-desk`, ownerToken);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.goal.slug).toBe('oil-desk');
      expect(body.open_tasks.map((task: any) => task.task_id)).toEqual([seeded[0].taskId]);
      expect(body.trigger).toMatchObject({
        slug: 'goal-oil-desk',
        enabled: true,
        cron: '0 0 9 * * *',
        agent: 'kortix-agi',
        // One long-running line of work per goal: every push re-prompts the same
        // session rather than minting a fresh one.
        session_mode: 'reuse',
      });
      expect(body.triggers_paused).toBe(false);
    } finally {
      await db.delete(agiTasks).where(
        inArray(
          agiTasks.taskId,
          seeded.map((row) => row.taskId),
        ),
      );
    }
  });

  test('a paused goal still shows its trigger, DISABLED — pausing reads as stopped, not vanished', async () => {
    const res = await req('GET', `${goalsPath()}/hire-ops`, ownerToken);
    const body = await res.json();

    expect(body.goal.status).toBe('paused');
    expect(body.trigger).toMatchObject({ slug: 'goal-hire-ops', enabled: false });
  });

  test('an on-demand goal reports no trigger at all', async () => {
    const res = await req('GET', `${goalsPath()}/on-demand`, ownerToken);
    expect((await res.json()).trigger).toBeNull();
  });
});

describe('POST /agi/goals/:slug/push', () => {
  const push = (slug: string, body: unknown = { reason: null }) =>
    req('POST', `${goalsPath()}/${slug}/push`, ownerToken, body);

  test('fires the goal’s derived trigger through the ordinary trigger path', async () => {
    fireResult = { status: 'fired', sessionId: crypto.randomUUID(), deduped: false };
    const res = await push('oil-desk');
    expect(res.status).toBe(202);
    const body = await res.json();

    expect(body).toMatchObject({
      status: 'fired',
      trigger_slug: 'goal-oil-desk',
      session_id: fireResult.sessionId,
      deduped: false,
    });

    expect(fired).toHaveLength(1);
    expect(fired[0].source).toBe('manual');
    expect(fired[0].spec.slug).toBe('goal-oil-desk');
    expect(fired[0].spec.agent).toBe('kortix-agi');
    expect(fired[0].renderedPrompt).toContain('Advance the goal');
    // R-9: a push may never be the act that declares a goal achieved.
    expect(fired[0].renderedPrompt).toContain('Do not mark the goal achieved');
  });

  test('the reason reaches the prompt — the push template has nowhere to render it', async () => {
    await push('oil-desk', { reason: 'board asked for a status by Friday' });
    expect(fired[0].renderedPrompt).toContain('board asked for a status by Friday');
    expect(fired[0].payload.reason).toBe('board asked for a status by Friday');
  });

  test('a non-string reason is a 400, not a stringified object in the prompt', async () => {
    const res = await push('oil-desk', { reason: { text: 'nope' } });
    expect(res.status).toBe(400);
    expect(fired).toHaveLength(0);
  });

  test('a goal with no push is a 409 the caller must not retry', async () => {
    const res = await push('on-demand');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('goal_no_push');
    expect(fired).toHaveLength(0);
  });

  test('a non-active goal is a 409 — status is authored state, not something push flips', async () => {
    const res = await push('hire-ops');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('goal_not_active');
    expect(fired).toHaveLength(0);
  });

  test('404s for a slug the manifest does not declare', async () => {
    expect((await push('nope')).status).toBe(404);
  });

  // The reserved-slug rule, end to end: when a human writes a `goal-<slug>`
  // trigger by hand, desugaring drops the goal's version and the authored one
  // wins. Resolving the spec through `extractTriggers` is what makes `goals push`
  // fire the same thing the cron sweep would.
  test('an authored trigger that claims the derived slug is what actually fires', async () => {
    manifestFile = yaml(`kortix_version: 2

goals:
  - slug: oil-desk
    done_when: Done.
    status: active
    push: "0 0 9 * * *"

triggers:
  - slug: goal-oil-desk
    type: cron
    agent: trader
    cron: "0 0 6 * * *"
    prompt: "Hand-written override"
`);
    const res = await push('oil-desk');
    expect(res.status).toBe(202);

    expect(fired).toHaveLength(1);
    expect(fired[0].spec.agent).toBe('trader');
    expect(fired[0].renderedPrompt).toBe('Hand-written override');
  });

  test('a fire that fails is a 500 and never records a successful fire', async () => {
    fireResult = { status: 'failed', error: 'No account owner available to own the session' };
    const res = await push('oil-desk');
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('No account owner available to own the session');
  });

  test('a successful push shows up as the trigger’s live state on the goal', async () => {
    await push('oil-desk');
    const res = await req('GET', `${goalsPath()}/oil-desk`, ownerToken);
    const body = await res.json();

    expect(body.trigger.last_status).toBe('fired');
    expect(body.trigger.last_fired_at).not.toBeNull();
  });
});
