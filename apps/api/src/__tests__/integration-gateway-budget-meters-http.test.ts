/**
 * Integration test (real HTTP route, real Postgres): GET /gateway/budgets
 * reports each budget's spend over that budget's own period, the same number
 * the gate (`checkBudget`) compares with the limit (KRTX-1725).
 *
 * The route used to send month-to-date spend only, and the budgets panel
 * divided it by every limit: a $20/day budget with $15 today and $280 this
 * month read 1400% under "Budget exceeded" while the gate admitted requests.
 *
 * The spend rows sit on both sides of the day, week and month boundaries, so a
 * budget that counts a row from before its period, or misses one at the exact
 * start, fails here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, gatewayBudgets, gatewayRequestLogs, projectMembers } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import { eq, inArray, sql } from 'drizzle-orm';
import { app } from '../index';
import { checkBudget } from '../llm-gateway/budgets';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const OTHER = crypto.randomUUID();
// A member with no spend at all, so no entry in the month-to-date `members`.
const QUIET = crypto.randomUUID();
const QUIET_EMAIL = `quiet-${QUIET.slice(0, 8)}@example.test`;
const DAY_MS = 86_400_000;

// The UTC periods, computed here without the product helpers.
const NOW = new Date();
const DAY_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
const WEEK_START = new Date(DAY_START.getTime() - ((NOW.getUTCDay() + 6) % 7) * DAY_MS);
const MONTH_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const STARTS = { day: DAY_START, week: WEEK_START, month: MONTH_START } as const;
const RESETS = {
  day: new Date(DAY_START.getTime() + DAY_MS),
  week: new Date(WEEK_START.getTime() + 7 * DAY_MS),
  month: new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1)),
} as const;

// Each row costs a distinct power of two, so a sum names exactly the rows it counted.
const ROWS = [
  { usd: 1, actor: MEMBER, at: NOW },
  { usd: 2, actor: MEMBER, at: DAY_START }, // the first instant of today counts
  { usd: 4, actor: MEMBER, at: new Date(DAY_START.getTime() - 1) }, // yesterday
  { usd: 8, actor: MEMBER, at: new Date(WEEK_START.getTime() - 1) }, // last week
  { usd: 16, actor: MEMBER, at: new Date(MONTH_START.getTime() - 1) }, // last month
  { usd: 32, actor: OTHER, at: NOW }, // another member, today
];

type Period = keyof typeof STARTS;
const spentSince = (start: Date, actor?: string) =>
  ROWS.filter((r) => r.at >= start && (!actor || r.actor === actor)).reduce((sum, r) => sum + r.usd, 0);

let project: SeededProject;
let unrelated: SeededProject;
let ownerSecret = '';
const minted: string[] = [];
// budget_id → [scope, period]
const budgetIds = new Map<string, { scope: 'project' | 'member'; period: Period }>();

interface WireBudget {
  budget_id: string;
  scope: 'project' | 'member';
  subject_user_id: string | null;
  subject_email?: string | null;
  period: Period;
  limit_usd: number;
  spent_usd: number;
  period_start: string;
  resets_at: string;
}

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  project = await seedProject('budget-meters');
  unrelated = await seedProject('budget-meters-other', { accountId: project.account_id });
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${QUIET}::uuid, ${QUIET_EMAIL}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner', isSuperAdmin: false },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  const owner = await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'budget-meters-owner' });
  minted.push(owner.tokenId);
  ownerSecret = owner.secretKey;

  const log = (projectId: string, row: (typeof ROWS)[number], n: number) => ({
    requestId: `budget-meters-${projectId}-${n}`,
    accountId: project.account_id,
    projectId,
    actorUserId: row.actor,
    requestedModel: 'm',
    resolvedModel: 'm',
    provider: 'test',
    status: 200,
    ok: true,
    finalCost: String(row.usd),
    billingMode: 'credits',
    createdAt: row.at,
  });
  await db.insert(gatewayRequestLogs).values([
    ...ROWS.map((row, n) => log(project.project_id, row, n)),
    // Spend in another project of the same account counts in no budget here.
    { ...log(unrelated.project_id, { usd: 64, actor: MEMBER, at: NOW }, 0) },
  ]);

  // 'warn' budgets with a limit every period passes, so checkBudget reports
  // each one as a 100% crossing that carries the spend it measured.
  const rows = await db
    .insert(gatewayBudgets)
    .values([
      ...(['day', 'week', 'month'] as const).map((period) => ({
        projectId: project.project_id,
        scope: 'project' as const,
        limitUsd: '0.0001',
        period,
        action: 'warn' as const,
      })),
      ...(['day', 'month'] as const).map((period) => ({
        projectId: project.project_id,
        scope: 'member' as const,
        subjectUserId: MEMBER,
        limitUsd: '0.0001',
        period,
        action: 'warn' as const,
      })),
    ])
    .returning({ budgetId: gatewayBudgets.budgetId, scope: gatewayBudgets.scope, period: gatewayBudgets.period });
  for (const row of rows) budgetIds.set(row.budgetId, { scope: row.scope, period: row.period });
}, 30_000);

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  if (!project) return;
  const ids = [project.project_id, unrelated.project_id];
  await db.delete(gatewayRequestLogs).where(inArray(gatewayRequestLogs.projectId, ids));
  await db.delete(gatewayBudgets).where(eq(gatewayBudgets.projectId, project.project_id));
  await removeSeeded([project, unrelated]);
  await db.execute(sql`delete from auth.users where id = ${QUIET}::uuid`);
});

/** Add member budgets for one test, then remove them, so the other tests see the seeded set. */
async function withMemberBudgets<T>(
  subjects: string[],
  work: () => Promise<T>,
): Promise<T> {
  const added = await db
    .insert(gatewayBudgets)
    .values(
      subjects.map((subjectUserId) => ({
        projectId: project.project_id,
        scope: 'member' as const,
        subjectUserId,
        limitUsd: '10',
        period: 'week' as const,
        action: 'block' as const,
      })),
    )
    .returning({ budgetId: gatewayBudgets.budgetId });
  try {
    return await work();
  } finally {
    await db.delete(gatewayBudgets).where(inArray(gatewayBudgets.budgetId, added.map((row) => row.budgetId)));
  }
}

/** The number of database statements one request ran: `db;desc="n=…"` in `Server-Timing` (lib/server-timing.ts). */
function dbStatements(res: Response): number {
  return Number(/(?:^|,)\s*db;[^,]*desc="n=(\d+)"/.exec(res.headers.get('server-timing') ?? '')?.[1]);
}

async function readBudgets(): Promise<WireBudget[]> {
  const res = await app.request(`/v1/projects/${project.project_id}/gateway/budgets`, {
    headers: { Authorization: `Bearer ${ownerSecret}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { budgets: WireBudget[] }).budgets;
}

describe('GET /gateway/budgets: spend per budget period', () => {
  test('each budget reports the spend of its own period, with the period start and the reset time', async () => {
    const budgets = await readBudgets();
    expect(budgets).toHaveLength(budgetIds.size);
    for (const b of budgets) {
      const { scope, period } = budgetIds.get(b.budget_id)!;
      expect({ scope: b.scope, period: b.period }).toEqual({ scope, period });
      expect(b.spent_usd).toBe(spentSince(STARTS[period], scope === 'member' ? MEMBER : undefined));
      expect(b.period_start).toBe(STARTS[period].toISOString());
      expect(b.resets_at).toBe(RESETS[period].toISOString());
    }
  });

  test('a daily budget counts today only, not the month: rows before midnight UTC are out', async () => {
    const budgets = await readBudgets();
    const day = budgets.find((b) => b.scope === 'project' && b.period === 'day')!;
    const memberDay = budgets.find((b) => b.scope === 'member' && b.period === 'day')!;
    // $1 now + $2 at 00:00:00.000 + $32 by the other member. Yesterday's $4 is out.
    expect(day.spent_usd).toBe(35);
    expect(memberDay.spent_usd).toBe(3);
  });

  test('a monthly budget starts on the 1st: the row one millisecond before is out', async () => {
    const budgets = await readBudgets();
    const month = budgets.find((b) => b.scope === 'project' && b.period === 'month')!;
    expect(month.spent_usd).toBe(spentSince(MONTH_START));
    // Powers of two: bit 16 is set only when last month's $16 row counted,
    // and bits 1, 2 and 32 are today's rows.
    expect(month.spent_usd & 16).toBe(0);
    expect(month.spent_usd & 35).toBe(35);
  });

  test('spent_usd equals the spend checkBudget measures, for every day, week and month budget', async () => {
    const principal = { accountId: project.account_id, projectId: project.project_id, userId: MEMBER } as AuthedPrincipal;
    const { exceeded, crossings } = await checkBudget(principal, 'warn');
    expect(exceeded).toBe(false);
    const gate = new Map((crossings ?? []).map((c) => [c.budgetId, c.spentUsd]));
    const budgets = await readBudgets();
    expect(gate.size).toBe(budgets.length);
    for (const b of budgets) expect(b.spent_usd).toBe(gate.get(b.budget_id)!);
  });

  test('the response keeps its month-to-date fields', async () => {
    const res = await app.request(`/v1/projects/${project.project_id}/gateway/budgets`, {
      headers: { Authorization: `Bearer ${ownerSecret}` },
    });
    const body = (await res.json()) as {
      project_spend: { requests: number; cost: number };
      members: Array<{ user_id: string; cost: number }>;
    };
    expect(body.project_spend.cost).toBe(spentSince(MONTH_START));
    expect(body.members.find((m) => m.user_id === OTHER)?.cost).toBe(32);
  });

  test('a member budget names its member, also when the member has no spend this month', async () => {
    await withMemberBudgets([QUIET], async () => {
      const res = await app.request(`/v1/projects/${project.project_id}/gateway/budgets`, {
        headers: { Authorization: `Bearer ${ownerSecret}` },
      });
      const body = (await res.json()) as { budgets: WireBudget[]; members: Array<{ user_id: string }> };
      // The month-to-date list has no row for this member: only the budget can name them.
      expect(body.members.some((m) => m.user_id === QUIET)).toBe(false);
      const quiet = body.budgets.find((b) => b.subject_user_id === QUIET);
      expect(quiet?.subject_email).toBe(QUIET_EMAIL);
      expect(quiet?.spent_usd).toBe(0);
      expect(body.budgets.find((b) => b.scope === 'project')?.subject_email).toBeNull();
    });
  });

  test('the spend of every budget is one statement: four more member budgets add no database statement', async () => {
    const read = () =>
      app.request(`/v1/projects/${project.project_id}/gateway/budgets`, {
        headers: { Authorization: `Bearer ${ownerSecret}` },
      });
    await read(); // fills the auth and access caches
    const seeded = dbStatements(await read());
    expect(seeded).toBeGreaterThan(0);
    const extra = Array.from({ length: 4 }, () => crypto.randomUUID());
    await withMemberBudgets(extra, async () => {
      const res = await read();
      expect(((await res.json()) as { budgets: WireBudget[] }).budgets).toHaveLength(budgetIds.size + extra.length);
      // One statement per budget, all at once, held every connection of the
      // API's 6-connection pool that the gate's budget check also waits on.
      expect(dbStatements(res)).toBe(seeded);
    });
  });
});
