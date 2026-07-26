/**
 * Real-DB integration over the mounted app for spec §4.2 end to end.
 *
 * The git read is the only thing stubbed (`readManifestFromRepo`), the same seam
 * the goal integration test uses — goals are read out of kortix.yaml on every
 * request. Everything downstream is real: the manifest parser, the observation
 * INSERT, the window function that rolls a series up, the flat-run detector, and
 * the authz prelude.
 *
 * What this file is actually here to prove:
 *   • `observe` is ONE verb every producer shares (R-12c), and a slug the
 *     manifest does not declare cannot write a series nobody will read;
 *   • recording an observation NEVER changes goal status (R-12f);
 *   • a threshold with zero readings surfaces as UNMEASURABLE, not on-track
 *     (R-12d) — the distinction the whole section exists for;
 *   • a metric flat across N readings surfaces as a stall on the SAME liveness
 *     route a stuck task does (R-12e).
 *
 * The `integration-` filename prefix is load-bearing: scripts/test.sh's default
 * bucket excludes it, because that bucket runs without a database. Run this with:
 *   KORTIX_URL=http://localhost:8008 dotenvx run --quiet -- \
 *     bun test src/agi/observations/integration-agi-observations-http.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/** Swapped per test — this is "what kortix.yaml says right now". */
let manifestFile: { path: string; content: string } | null = null;

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

const { eq, inArray, sql } = await import('drizzle-orm');
const { accountMembers, accounts, agiObservations, projectMembers, projects } = await import(
  '@kortix/db'
);
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

/**
 * Three goals covering the three measurability cases:
 *   seo       — a threshold ("top 3"), the one every test records against.
 *   hire-ops  — prose with no threshold: legal under R-7, `unquantified`.
 *   oil-desk  — a threshold nothing is ever recorded for: `unmeasurable`.
 */
const MANIFEST = `kortix_version: 2

goals:
  - slug: seo
    title: Top 3 on the core terms
    done_when: Top 3 for the core terms, sustained 30 days.
    status: active
    push: "0 0 9 * * *"

  - slug: hire-ops
    title: Ops lead hired
    done_when: An offer is signed and a start date is on the calendar.
    status: active

  - slug: oil-desk
    title: Oil trades running 24/7
    done_when: A live account runs the strategy unattended for 7 days.
    status: active
`;

const yaml = (content: string) => ({ path: 'kortix.yaml', content });

beforeAll(async () => {
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );

  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'agi-observations-test' },
    { accountId: OUTSIDER_ACCOUNT, name: 'agi-observations-test-outsider' },
  ]);
  await db.insert(projects).values([
    {
      projectId: WORKSPACE,
      accountId: ACCOUNT,
      name: 'agi-observations-test-workspace',
      repoUrl: 'https://example.com/agi-observations-test.git',
      manifestPath: 'kortix.yaml',
      metadata: { experimental: { agi: true } },
    },
    {
      projectId: WORKSPACE_OFF,
      accountId: ACCOUNT,
      name: 'agi-observations-test-workspace-off',
      repoUrl: 'https://example.com/agi-observations-test-off.git',
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
});

afterEach(async () => {
  await db.delete(agiObservations).where(eq(agiObservations.workspaceId, WORKSPACE));
});

async function mint(accountId: string, userId: string): Promise<string> {
  const token = await createAccountToken({ accountId, userId, name: 'agi-observations-test' });
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
const observePath = (slug: string, workspace = WORKSPACE) =>
  `${goalsPath(workspace)}/${slug}/observations`;

/** Record one reading. Timestamps are explicit so a series has a deterministic
 *  order — several inserts inside one millisecond would otherwise tie. */
function observe(slug: string, metric: string, value: number, extra: Record<string, unknown> = {}) {
  return req('POST', observePath(slug), ownerToken, { metric, value, ...extra });
}

/** A run of readings, oldest first, one day apart. */
async function seedSeries(slug: string, metric: string, values: number[]) {
  const base = Date.UTC(2026, 6, 1, 9, 0, 0);
  for (const [index, value] of values.entries()) {
    const res = await observe(slug, metric, value, {
      observed_at: new Date(base + index * 86_400_000).toISOString(),
    });
    expect(res.status).toBe(201);
  }
}

describe('experimental gate (R-44)', () => {
  const routes: Array<{ name: string; method: string; body?: unknown }> = [
    { name: 'observe', method: 'POST', body: { metric: 'rank', value: 9 } },
    { name: 'series', method: 'GET' },
  ];

  test.each(routes)('$name 404s when the project has not enabled agi', async (route) => {
    const res = await req(route.method, observePath('seo', WORKSPACE_OFF), ownerToken, route.body);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('AGI is not enabled for this project');
  });

  test.each(routes)('$name checks the gate AFTER authz — a non-member gets 403', async (route) => {
    for (const workspace of [WORKSPACE, WORKSPACE_OFF]) {
      const res = await req(route.method, observePath('seo', workspace), outsiderToken, route.body);
      expect(res.status).toBe(403);
    }
  });
});

describe('POST /agi/goals/:slug/observations (R-12c)', () => {
  test('records a reading and attributes it to the caller', async () => {
    const res = await observe('seo', 'rank', 12);
    expect(res.status).toBe(201);
    const { observation } = await res.json();

    expect(observation).toMatchObject({
      workspace_id: WORKSPACE,
      goal_slug: 'seo',
      metric: 'rank',
      value: 12,
    });
    // `--source` defaults to the caller, never to nothing: an unattributed
    // number is not evidence.
    expect(observation.source).toBe(`user:${OWNER}`);
    expect(observation.observed_at).toBeTruthy();
  });

  test('normalizes the metric name server-side so one metric is one series', async () => {
    // The failure this closes: `Google Rank` and `google_rank` as two series that
    // each look healthy while neither has moved.
    expect((await observe('seo', 'Google Rank', 9)).status).toBe(201);
    expect((await observe('seo', 'google_rank', 8)).status).toBe(201);

    const res = await req('GET', observePath('seo'), ownerToken);
    const { observations } = await res.json();
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((o: any) => o.metric))).toEqual(new Set(['google_rank']));
  });

  test('an explicit --source is kept verbatim — that is how a webhook attributes a reading', async () => {
    const res = await observe('seo', 'rank', 9, { source: 'webhook:search-console' });
    expect((await res.json()).observation.source).toBe('webhook:search-console');
  });

  test('a caller-supplied observed_at is honoured, and a far-future one is refused', async () => {
    const earlier = new Date(Date.UTC(2026, 0, 1, 12)).toISOString();
    const ok = await observe('seo', 'rank', 9, { observed_at: earlier });
    expect((await ok.json()).observation.observed_at).toBe(earlier);

    // A reading dated next month would pin `latest` until that date arrives,
    // freezing the goal's direction of travel.
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const bad = await observe('seo', 'rank', 9, { observed_at: future });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('future');
  });

  test('a slug the manifest does not declare is a 404, not a write nobody reads (R-12c)', async () => {
    const res = await observe('not-a-goal', 'rank', 9);
    expect(res.status).toBe(404);
    const rows = await db
      .select()
      .from(agiObservations)
      .where(eq(agiObservations.workspaceId, WORKSPACE));
    expect(rows).toEqual([]);
  });

  test('a non-number, NaN-ish, or missing value is a 400 before any SQL runs', async () => {
    for (const body of [
      { metric: 'rank' },
      { metric: 'rank', value: '9' },
      { metric: 'rank', value: null },
      { value: 9 },
      { metric: 'impressions/day', value: 9 },
    ]) {
      const res = await req('POST', observePath('seo'), ownerToken, body);
      expect(res.status).toBe(400);
    }
  });

  test('two readings of the same value are BOTH kept — repetition is what a flat line is made of', async () => {
    await seedSeries('seo', 'rank', [9, 9]);
    const res = await req('GET', `${observePath('seo')}?metric=rank`, ownerToken);
    expect((await res.json()).observations).toHaveLength(2);
  });

  // R-12f. The most important assertion in the file.
  test('recording an observation NEVER changes goal status', async () => {
    const before = await req('GET', `${goalsPath()}/seo`, ownerToken);
    expect((await before.json()).goal.status).toBe('active');

    // A reading that would satisfy the threshold outright, recorded many times.
    await seedSeries('seo', 'rank', [1, 1, 1, 1]);

    const after = await req('GET', `${goalsPath()}/seo`, ownerToken);
    const body = await after.json();
    expect(body.goal.status).toBe('active');
    // The manifest — the ONLY place status lives (R-9) — is untouched.
    expect(body.goal.path).toBe('kortix.yaml#goals.seo');
  });
});

describe('GET /agi/goals/:slug/observations (R-12b)', () => {
  test('returns the series newest first, filterable by metric and range', async () => {
    await seedSeries('seo', 'rank', [12, 11, 9]);
    await seedSeries('seo', 'impressions', [400]);

    const all = await req('GET', observePath('seo'), ownerToken);
    expect((await all.json()).observations).toHaveLength(4);

    const ranked = await req('GET', `${observePath('seo')}?metric=rank`, ownerToken);
    expect((await ranked.json()).observations.map((o: any) => o.value)).toEqual([9, 11, 12]);

    // Day 2 onwards: the range read R-12b asks for.
    const since = new Date(Date.UTC(2026, 6, 2, 0, 0, 0)).toISOString();
    const recent = await req(
      'GET',
      `${observePath('seo')}?metric=rank&since=${encodeURIComponent(since)}`,
      ownerToken,
    );
    expect((await recent.json()).observations.map((o: any) => o.value)).toEqual([9, 11]);
  });

  test('the metric filter is normalized too, so a display name still finds its series', async () => {
    await seedSeries('seo', 'google_rank', [9]);
    const res = await req('GET', `${observePath('seo')}?metric=Google%20Rank`, ownerToken);
    expect((await res.json()).observations).toHaveLength(1);
  });

  test('a bad range is a 400, and a full page reports itself truncated', async () => {
    expect((await req('GET', `${observePath('seo')}?since=tuesday`, ownerToken)).status).toBe(400);

    await seedSeries('seo', 'rank', [1, 2, 3]);
    const res = await req('GET', `${observePath('seo')}?limit=2`, ownerToken);
    const body = await res.json();
    expect(body.observations).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });
});

describe('goals carry their metrics (R-12)', () => {
  test('the list rolls latest, previous, direction, and the flat run onto each goal', async () => {
    await seedSeries('seo', 'rank', [12, 11, 9]);

    const res = await req('GET', goalsPath(), ownerToken);
    const seo = (await res.json()).goals.find((goal: any) => goal.slug === 'seo');

    expect(seo.measurability).toBe('measured');
    expect(seo.metrics).toHaveLength(1);
    expect(seo.metrics[0]).toMatchObject({
      metric: 'rank',
      latest: { value: 9 },
      previous: { value: 11 },
      // Lower rank is a smaller number; direction is arithmetic, never semantic —
      // the API does not know that "down" is good here.
      direction: 'down',
      flat_observations: 0,
    });
  });

  // R-12d, end to end. This is the whole point of §4.2.
  test('a threshold with zero readings is UNMEASURABLE on every goal surface, never on-track', async () => {
    const res = await req('GET', goalsPath(), ownerToken);
    const goals = (await res.json()).goals;

    const oil = goals.find((goal: any) => goal.slug === 'oil-desk');
    expect(oil.status).toBe('active');
    expect(oil.metrics).toEqual([]);
    expect(oil.measurability).toBe('unmeasurable');

    // Prose with nothing to measure is a DIFFERENT state — not a defect.
    expect(goals.find((goal: any) => goal.slug === 'hire-ops').measurability).toBe('unquantified');
  });

  test('the detail view adds the points themselves, oldest → newest', async () => {
    await seedSeries('seo', 'rank', [12, 11, 9]);
    const res = await req('GET', `${goalsPath()}/seo`, ownerToken);
    const body = await res.json();

    expect(body.metric_series).toHaveLength(1);
    expect(body.metric_series[0].series.map((point: any) => point.value)).toEqual([12, 11, 9]);
    // The goal object is byte-identical to the list's, series and all.
    expect(body.goal.metrics[0]).toEqual((({ series, ...rest }) => rest)(body.metric_series[0]));
  });

  test('one query serves every goal — another goal’s series never leaks in', async () => {
    await seedSeries('seo', 'rank', [9]);
    await seedSeries('oil-desk', 'pnl', [100]);

    const res = await req('GET', goalsPath(), ownerToken);
    const goals = (await res.json()).goals;
    expect(goals.find((g: any) => g.slug === 'seo').metrics.map((m: any) => m.metric)).toEqual([
      'rank',
    ]);
    expect(goals.find((g: any) => g.slug === 'oil-desk').metrics.map((m: any) => m.metric)).toEqual(
      ['pnl'],
    );
    expect(goals.find((g: any) => g.slug === 'hire-ops').metrics).toEqual([]);
  });
});

describe('the flat line surfaces as a stall (R-12e)', () => {
  const livenessPath = `/v1/projects/${WORKSPACE}/agi/liveness`;

  test('a metric flat across three readings stalls the goal on the SAME liveness route', async () => {
    // Four readings, three of them without movement: the loop looks alive and
    // the number has not moved. Nobody had to notice.
    await seedSeries('seo', 'rank', [9, 9, 9, 9]);

    const res = await req('GET', livenessPath, ownerToken);
    expect(res.status).toBe(200);
    const body = await res.json();

    const seo = body.goals.find((goal: any) => goal.slug === 'seo');
    expect(seo.liveness).toMatchObject({
      state: 'stalled',
      reason: 'metric_flat',
      flat_stall_after: 3,
    });
    expect(seo.liveness.flat_metrics).toEqual([{ metric: 'rank', flat_observations: 3 }]);

    expect(body.stalled_goals.map((goal: any) => goal.slug)).toContain('seo');
    expect(body.stalled_goal_count).toBe(1);
    // The task half of the surface is untouched — a flat goal is not a task.
    expect(body.stalled_count).toBe(0);
    expect(body.stalled_total).toBe(1);
  });

  test('a metric short of the threshold, or one that moved, is not a stall', async () => {
    await seedSeries('seo', 'rank', [9, 9, 9]);
    let body = await (await req('GET', livenessPath, ownerToken)).json();
    expect(body.goals.find((g: any) => g.slug === 'seo').liveness.state).toBe('measuring');
    expect(body.stalled_goal_count).toBe(0);

    await observe('seo', 'rank', 8, {
      observed_at: new Date(Date.UTC(2026, 6, 9, 9)).toISOString(),
    });
    body = await (await req('GET', livenessPath, ownerToken)).json();
    expect(body.goals.find((g: any) => g.slug === 'seo').liveness.state).toBe('measuring');
  });

  test('one metric still moving keeps the goal off the stall list', async () => {
    await seedSeries('seo', 'rank', [9, 9, 9, 9]);
    await seedSeries('seo', 'signups', [31, 40]);

    const body = await (await req('GET', livenessPath, ownerToken)).json();
    const seo = body.goals.find((goal: any) => goal.slug === 'seo');
    expect(seo.liveness.state).toBe('measuring');
    // The flat metric is still named, so it is visible before it stalls the goal.
    expect(seo.liveness.flat_metrics.map((m: any) => m.metric)).toEqual(['rank']);
    expect(body.stalled_goal_count).toBe(0);
  });

  // R-12d on the stall surface: un-judged is its own bucket, not "stalled" and
  // certainly not "fine".
  test('an unmeasurable goal is reported separately from a stalled one', async () => {
    const body = await (await req('GET', livenessPath, ownerToken)).json();

    expect(body.unmeasurable_goals.map((goal: any) => goal.slug).sort()).toEqual([
      'oil-desk',
      'seo',
    ]);
    expect(body.unmeasurable_goal_count).toBe(2);
    expect(body.stalled_goal_count).toBe(0);
    expect(body.stalled_total).toBe(0);
  });

  test('a paused or achieved goal is settled, never stalled — pausing is a choice', async () => {
    manifestFile = yaml(`kortix_version: 2

goals:
  - slug: seo
    done_when: Top 3 for the core terms.
    status: paused
  - slug: oil-desk
    done_when: A positive risk-adjusted return over 7 days.
    status: achieved
`);
    await seedSeries('seo', 'rank', [9, 9, 9, 9]);

    const body = await (await req('GET', livenessPath, ownerToken)).json();
    const byslug = new Map(body.goals.map((goal: any) => [goal.slug, goal.liveness.state]));
    expect(byslug.get('seo')).toBe('paused');
    expect(byslug.get('oil-desk')).toBe('settled');
    expect(body.stalled_goal_count).toBe(0);
    expect(body.unmeasurable_goal_count).toBe(0);
  });
});
