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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  executorExecutions,
  projectSessions,
  sessionLifecycleCommands,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { getCreditAccount, setDemoEnterprise } from '../billing/repositories/credit-accounts';
import { config } from '../config';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { mintSetupLink } from '../setup-links/token';
import { db } from '../shared/db';

const minted: string[] = [];
const execIds: string[] = [];
const SESSION = crypto.randomUUID();
let ctx: { projectId: string; accountId: string; userId: string } | null = null;
let secret = '';
let humanToken = '';
let humanUserId = '';
let priorDemoEnterprise = false;

beforeAll(async () => {
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );
  await db.execute(
    sql`alter table kortix.credit_accounts add column if not exists demo_enterprise boolean not null default false`,
  );
  const rows = (await db.execute(sql`
    select p.project_id, p.account_id, m.user_id
    from kortix.projects p
    join kortix.account_members m on m.account_id = p.account_id and m.account_role = 'owner'
    limit 1`)) as unknown as Array<{ project_id: string; account_id: string; user_id: string }>;
  const r = rows[0];
  if (!r) return;
  ctx = { projectId: r.project_id, accountId: r.account_id, userId: r.user_id };
  const t = await createAccountToken({
    accountId: ctx.accountId,
    userId: ctx.userId,
    name: 'approvals-test',
  });
  minted.push(t.tokenId);
  secret = t.secretKey;
  const email = `approvals-${crypto.randomUUID()}@example.test`;
  const password = `Approval-${crypto.randomUUID()}-aA1!`;
  const created = await fetch(`${config.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: config.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  expect(created.status).toBe(200);
  const createdBody = (await created.json()) as { id?: string; user?: { id?: string } };
  humanUserId = createdBody.user?.id ?? createdBody.id ?? '';
  expect(humanUserId).not.toBe('');
  await db.insert(accountMembers).values({
    accountId: ctx.accountId,
    userId: humanUserId,
    accountRole: 'owner',
  });
  const signedIn = await fetch(`${config.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: config.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  expect(signedIn.status).toBe(200);
  humanToken = ((await signedIn.json()) as { access_token?: string }).access_token ?? '';
  expect(humanToken).not.toBe('');
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: 'approvals-test',
    createdBy: humanUserId,
    visibility: 'private',
  });
  // The full-trail assertions below need the auditAccess entitlement; flip the
  // enterprise demo on for the suite (restored in afterAll). The unentitled
  // contract has its own dedicated test that toggles it off.
  priorDemoEnterprise = (await getCreditAccount(ctx.accountId))?.demoEnterprise ?? false;
  await setDemoEnterprise(ctx.accountId, true);
});

afterAll(async () => {
  for (const id of execIds)
    await db.delete(executorExecutions).where(eq(executorExecutions.executionId, id));
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, SESSION));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION));
  for (const id of minted)
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${id}`);
  if (ctx && humanUserId) {
    await db
      .delete(accountMembers)
      .where(
        sql`${accountMembers.accountId} = ${ctx.accountId} and ${accountMembers.userId} = ${humanUserId}`,
      );
    await fetch(`${config.SUPABASE_URL}/auth/v1/admin/users/${humanUserId}`, {
      method: 'DELETE',
      headers: {
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
  }
  if (ctx) await setDemoEnterprise(ctx.accountId, priorDemoEnterprise);
});

async function seedPending(argsPreviewComplete = true): Promise<string> {
  if (!ctx) throw new Error('approval integration test has no project context');
  const [row] = await db
    .insert(executorExecutions)
    .values({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      actionPath: 'github.repos.delete',
      actingUserId: ctx.userId,
      sessionId: SESSION,
      status: 'pending_approval',
      risk: null,
      resolvedAt: null, // genuinely awaiting a decision
      resultSummary: {
        args_preview: { repo: 'kortix-ai/suna' },
        args_preview_complete: argsPreviewComplete,
      },
    })
    .returning({ id: executorExecutions.executionId });
  execIds.push(row.id);
  return row.id;
}

const authGet = (path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${humanToken}` } });
const authPost = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${humanToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const patPost = (path: string, body: unknown) =>
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
    const listBody = (await list.json()) as { approvals: Array<{ execution_id: string }> };
    expect(listBody.approvals.some((approval) => approval.execution_id === execId)).toBe(true);

    const ap = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'approve',
    });
    expect(ap.status).toBe(200);
    const [after] = await db
      .select()
      .from(executorExecutions)
      .where(eq(executorExecutions.executionId, execId));
    // Approve clears the gate to the terminal `ok` + stamps the resolver.
    expect(after.status).toBe('ok');
    expect(after.approvedBy).toBe(humanUserId);
    expect(after.resolvedAt).toBeTruthy();
    const [callback] = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, `approval-resume:${execId}`));
    expect(callback?.commandType).toBe('continue_session');
    expect(callback?.payload).toMatchObject({ executionId: execId });

    const list2 = await authGet(`/v1/projects/${ctx.projectId}/approvals`);
    const list2Body = (await list2.json()) as { approvals: Array<{ execution_id: string }> };
    expect(list2Body.approvals.some((approval) => approval.execution_id === execId)).toBe(false);

    const again = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'approve',
    });
    expect(again.status).toBe(409);

    const audit = await authGet(`/v1/projects/${ctx.projectId}/sessions/${SESSION}/audit`);
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as {
      audit_access: boolean;
      actions: Array<{ execution_id: string; resolved_by: string | null }>;
    };
    expect(auditBody.audit_access).toBe(true);
    const entry = auditBody.actions.find((action) => action.execution_id === execId);
    expect(entry?.resolved_by).toBe(humanUserId);
  });

  test('unentitled account: audit degrades to pending-only (never a 402 — the approval control plane)', async () => {
    if (!ctx) return;
    // A resolved action (history) + a still-pending one.
    const resolvedId = await seedPending();
    await authPost(`/v1/projects/${ctx.projectId}/approvals/${resolvedId}`, {
      decision: 'approve',
    });
    const pendingId = await seedPending();

    await setDemoEnterprise(ctx.accountId, false);
    try {
      const res = await authGet(`/v1/projects/${ctx.projectId}/sessions/${SESSION}/audit`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        audit_access: boolean;
        actions: Array<{ execution_id: string; status: string }>;
      };
      expect(body.audit_access).toBe(false);
      const ids = body.actions.map((action) => action.execution_id);
      expect(ids).toContain(pendingId);
      expect(ids).not.toContain(resolvedId);
      expect(body.actions.every((action) => action.status === 'pending_approval')).toBe(true);
    } finally {
      await setDemoEnterprise(ctx.accountId, true);
    }
  });

  test('deny flips the action to denied + records the denier', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const dn = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'deny',
    });
    expect(dn.status).toBe(200);
    const [after] = await db
      .select()
      .from(executorExecutions)
      .where(eq(executorExecutions.executionId, execId));
    expect(after.status).toBe('denied');
    expect(after.resolvedAt).toBeTruthy();
    // The denier is recorded too, so the audit trail attributes the refusal.
    expect(after.approvedBy).toBe(humanUserId);
  });

  test('a PAT cannot approve even when it belongs to an account owner', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const response = await patPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'approve',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'APPROVAL_REQUIRES_HUMAN' });
  });

  test('the shared approval link requires a human account and returns complete parameters', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const { token } = mintSetupLink(ctx.projectId, {
      kind: 'approval',
      executionId: execId,
      sessionId: SESSION,
    });

    const anonymous = await app.request(`/v1/approval-links/${token}`);
    expect(anonymous.status).toBe(401);

    const automated = await app.request(`/v1/approval-links/${token}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(automated.status).toBe(403);
    expect(await automated.json()).toMatchObject({ code: 'APPROVAL_REQUIRES_HUMAN' });

    const human = await authGet(`/v1/approval-links/${token}`);
    expect(human.status).toBe(200);
    expect(await human.json()).toMatchObject({
      execution_id: execId,
      pending: true,
      review_complete: true,
      args_preview: { repo: 'kortix-ai/suna' },
    });
  });

  test('an incomplete parameter preview blocks approve but still permits deny', async () => {
    if (!ctx) return;
    const execId = await seedPending(false);
    const approve = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'approve',
    });
    expect(approve.status).toBe(409);
    expect(await approve.json()).toMatchObject({ code: 'APPROVAL_PREVIEW_INCOMPLETE' });

    const deny = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'deny',
    });
    expect(deny.status).toBe(200);
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

  test('an outbox insert failure rolls the approval decision back', async () => {
    if (!ctx) return;
    const missingSessionId = crypto.randomUUID();
    const [row] = await db
      .insert(executorExecutions)
      .values({
        accountId: ctx.accountId,
        projectId: ctx.projectId,
        actionPath: 'github.repos.delete',
        actingUserId: ctx.userId,
        sessionId: missingSessionId,
        status: 'pending_approval',
        resultSummary: {
          args_preview: { repo: 'kortix-ai/suna' },
          args_preview_complete: true,
        },
      })
      .returning({ id: executorExecutions.executionId });
    execIds.push(row.id);

    const response = await authPost(`/v1/projects/${ctx.projectId}/approvals/${row.id}`, {
      decision: 'approve',
    });
    expect(response.status).toBe(500);

    const [after] = await db
      .select()
      .from(executorExecutions)
      .where(eq(executorExecutions.executionId, row.id));
    expect(after.status).toBe('pending_approval');
    expect(after.approvedBy).toBeNull();
    expect(after.resolvedAt).toBeNull();
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
    const after = await (
      await authGet(`/v1/projects/${ctx.projectId}/approvals/needs-input`)
    ).json();
    expect(after.sessions[SESSION] ?? 0).toBe(before - 1);
  });

  test('an invalid decision is rejected 400', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const bad = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'maybe',
    });
    expect(bad.status).toBe(400);
  });
});
