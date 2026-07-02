/**
 * HTTP-level test (in-process app + real DB) of the APPROVE/ASK/BLOCK inbox loop:
 *   - a policy-gated `pending_approval` execution shows in GET /approvals,
 *   - a manager (or the session launcher) resolves it via POST /approvals/:id,
 *   - approve stamps approvedBy + resolvedAt and drops it from the inbox,
 *   - re-resolving a resolved one 409s, an invalid decision 400s,
 *   - deny flips it to `denied`,
 *   - and the per-session /audit trail surfaces the action + who approved it.
 * Reuses the local DB's owner (a manager on every project) as the caller.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { executorExecutions, projectSessions } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';

const minted: string[] = [];
const execIds: string[] = [];
const SESSION = crypto.randomUUID();
let ctx: { projectId: string; accountId: string; userId: string } | null = null;
let secret = '';

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  const rows = (await db.execute(sql`
    select p.project_id, p.account_id, m.user_id
    from kortix.projects p
    join kortix.account_members m on m.account_id = p.account_id and m.account_role = 'owner'
    limit 1`)) as unknown as Array<{ project_id: string; account_id: string; user_id: string }>;
  const r = rows[0];
  if (!r) return;
  ctx = { projectId: r.project_id, accountId: r.account_id, userId: r.user_id };
  const t = await createAccountToken({ accountId: ctx.accountId, userId: ctx.userId, name: 'approvals-test' });
  minted.push(t.tokenId);
  secret = t.secretKey;
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: 'approvals-test',
    createdBy: ctx.userId,
    visibility: 'private',
  });
});

afterAll(async () => {
  for (const id of execIds) await db.delete(executorExecutions).where(eq(executorExecutions.executionId, id));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION));
  for (const id of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${id}`);
});

async function seedPending(): Promise<string> {
  const [row] = await db
    .insert(executorExecutions)
    .values({
      accountId: ctx!.accountId,
      projectId: ctx!.projectId,
      actionPath: 'github.repos.delete',
      actingUserId: ctx!.userId,
      sessionId: SESSION,
      status: 'pending_approval',
      risk: null,
      resolvedAt: null, // genuinely awaiting a decision
    })
    .returning({ id: executorExecutions.executionId });
  execIds.push(row.id);
  return row.id;
}
const authGet = (path: string) => app.request(path, { headers: { Authorization: `Bearer ${secret}` } });
const authPost = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('approvals inbox + resolution', () => {
  test('pending → inbox → approve → resolved (leaves inbox) → re-approve 409 → audit shows approver', async () => {
    if (!ctx) {
      console.warn('[integration] no project/owner in local DB — skipping');
      return;
    }
    const execId = await seedPending();

    const list = await authGet(`/v1/projects/${ctx.projectId}/approvals`);
    expect(list.status).toBe(200);
    expect((await list.json()).approvals.some((a: any) => a.execution_id === execId)).toBe(true);

    const ap = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, { decision: 'approve' });
    expect(ap.status).toBe(200);
    const [after] = await db.select().from(executorExecutions).where(eq(executorExecutions.executionId, execId));
    // Approve clears the gate to the terminal `ok` + stamps the resolver.
    expect(after.status).toBe('ok');
    expect(after.approvedBy).toBe(ctx.userId);
    expect(after.resolvedAt).toBeTruthy();

    const list2 = await authGet(`/v1/projects/${ctx.projectId}/approvals`);
    expect((await list2.json()).approvals.some((a: any) => a.execution_id === execId)).toBe(false);

    const again = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, { decision: 'approve' });
    expect(again.status).toBe(409);

    const audit = await authGet(`/v1/projects/${ctx.projectId}/sessions/${SESSION}/audit`);
    expect(audit.status).toBe(200);
    const entry = (await audit.json()).actions.find((a: any) => a.execution_id === execId);
    expect(entry?.resolved_by).toBe(ctx.userId);
  });

  test('deny flips the action to denied + records the denier', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const dn = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, { decision: 'deny' });
    expect(dn.status).toBe(200);
    const [after] = await db.select().from(executorExecutions).where(eq(executorExecutions.executionId, execId));
    expect(after.status).toBe('denied');
    expect(after.resolvedAt).toBeTruthy();
    // The denier is recorded too, so the audit trail attributes the refusal.
    expect(after.approvedBy).toBe(ctx.userId);
  });

  test('concurrent resolves race-safely: exactly one 200, the other 409', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const [a, b] = await Promise.all([
      authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, { decision: 'approve' }),
      authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, { decision: 'deny' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  test('needs-input summary counts the session, and decrements when resolved', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const res = await authGet(`/v1/projects/${ctx.projectId}/approvals/needs-input`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const before = body.sessions[SESSION] ?? 0;
    expect(before).toBeGreaterThanOrEqual(1);
    // Resolving one drops this session's count by exactly one.
    await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, { decision: 'approve' });
    const after = await (await authGet(`/v1/projects/${ctx.projectId}/approvals/needs-input`)).json();
    expect(after.sessions[SESSION] ?? 0).toBe(before - 1);
  });

  test('an invalid decision is rejected 400', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const bad = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, { decision: 'maybe' });
    expect(bad.status).toBe(400);
  });
});
