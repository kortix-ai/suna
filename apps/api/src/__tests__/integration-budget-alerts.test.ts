/**
 * Integration test (real local DB): a gateway budget at 80% and at 100% emails
 * the people who manage budgets, once per threshold per period (KRTX-1718).
 * A 'warn' budget used to write one log line per request and nothing a person
 * saw. Real: the budget, the spend rows, the account and project roles, the
 * emails in auth.users. Captured: the email transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, chatEventDedup, gatewayBudgets, gatewayRequestLogs, projectMembers } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import { eq, like, sql } from 'drizzle-orm';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import { alertBudgetCrossings, forgetHandledBudgetAlertsForTest } from '../llm-gateway/budget-alerts';
import { checkBudget } from '../llm-gateway/budgets';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const email = (id: string, label: string) => `budget-${label}-${id.slice(0, 8)}@example.test`;

let project: SeededProject;
let sent: EmailMessage[] = [];
let spendRow = 0;

async function spend(usd: number) {
  spendRow += 1;
  await db.insert(gatewayRequestLogs).values({
    requestId: `budget-alert-${project.project_id}-${spendRow}`,
    accountId: project.account_id,
    projectId: project.project_id,
    actorUserId: MEMBER,
    requestedModel: 'm',
    resolvedModel: 'm',
    provider: 'test',
    status: 200,
    ok: true,
    finalCost: String(usd),
    billingMode: 'credits',
  });
}

async function check() {
  const principal = { accountId: project.account_id, projectId: project.project_id, userId: MEMBER } as AuthedPrincipal;
  const { crossings } = await checkBudget(principal);
  return { crossings, sent: crossings ? await alertBudgetCrossings(project.project_id, crossings) : 0 };
}

beforeAll(async () => {
  project = await seedProject('budget-alerts');
  const user = (id: string, label: string) =>
    sql`(${id}::uuid, ${email(id, label)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values ${user(OWNER, 'owner')}, ${user(ADMIN, 'admin')}, ${user(MANAGER, 'manager')}, ${user(MEMBER, 'member')}`);
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: ADMIN, accountId: project.account_id, accountRole: 'admin' },
    { userId: MANAGER, accountId: project.account_id, accountRole: 'member' },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MANAGER, projectRole: 'manager' },
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  await db.insert(gatewayBudgets).values({
    projectId: project.project_id,
    scope: 'project',
    limitUsd: '10',
    period: 'day',
    action: 'warn',
  });
  setOwnerAlertSenderForTest(async (message) => {
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
}, 20_000);

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  setOwnerAlertSenderForTest(null);
  if (!project) return;
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, 'billing:budget-alert:%'));
  await db.delete(gatewayRequestLogs).where(eq(gatewayRequestLogs.projectId, project.project_id));
  await db.delete(gatewayBudgets).where(eq(gatewayBudgets.projectId, project.project_id));
  await removeSeeded([project]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ADMIN}::uuid, ${MANAGER}::uuid, ${MEMBER}::uuid)`);
});

const recipients = () => sent.map((m) => m.to[0]).sort();
const managers = () => [email(OWNER, 'owner'), email(ADMIN, 'admin'), email(MANAGER, 'manager')].sort();

describe('a warn budget reaches its thresholds', () => {
  test('below 80%: nothing', async () => {
    await spend(7.5);
    expect(await check()).toEqual({ crossings: undefined, sent: 0 });
  });

  test('at 85%: one email to each budget manager (owner, admin, project manager), not the member', async () => {
    await spend(1);
    const result = await check();
    expect(result.crossings).toMatchObject([{ threshold: 80, action: 'warn', period: 'day', limitUsd: 10, spentUsd: 8.5 }]);
    expect(result.sent).toBe(3);
    expect(recipients()).toEqual(managers());
    expect(sent[0]!.subject).toBe('budget-alerts reached 80% of its gateway budget');
    expect(sent[0]!.text).toContain('The daily budget of budget-alerts is at $8.50 of $10.00 (85%).');
    expect(sent[0]!.text).toContain('It is a warn-only budget: requests keep running.');
    expect(sent[0]!.text).toContain(`/projects/${project.project_id}/customize/models`);
    expect(sent[0]!.category).toBe('billing-budget-alert');
  });

  test('more requests at 85% email nobody again', async () => {
    expect((await check()).sent).toBe(0);
    // Another replica, which never saw it: the claim row still stops it.
    forgetHandledBudgetAlertsForTest();
    expect((await check()).sent).toBe(0);
    expect(sent).toEqual([]);
  });

  test('at 100%: one more email each, once', async () => {
    await spend(2);
    expect((await check()).sent).toBe(3);
    expect(sent[0]!.subject).toBe('budget-alerts reached 100% of its gateway budget');
    expect((await check()).sent).toBe(0);
  });
});
