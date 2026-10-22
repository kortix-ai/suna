/**
 * HTTP-level test (in-process app + real DB) of the APPROVE/ASK/BLOCK inbox loop:
 *   - a policy-gated `pending_approval` execution shows in GET /approvals,
 *   - a manager (or the session launcher) resolves it via POST /approvals/:id,
 *   - approve stamps approvedBy + resolvedAt and drops it from the inbox,
 *   - re-resolving a resolved one 409s, an invalid decision 400s,
 *   - deny flips it to `denied`,
 *   - and the per-session /audit trail surfaces the action + who approved it.
 * Seeds its own account + project + owner: the db-suites lane hands every file
 * a bare migrated template with no ambient rows, and a suite that borrowed the
 * local dev DB's owner silently no-opped there.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  auditEvents,
  connectorCalls,
  connectors,
  projectMembers,
  projectSessions,
  projects,
  sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { getCreditAccount } from '../billing/repositories/credit-accounts';
import { applyAdminOverride } from '../billing/services/account-write-owner';
import { deleteFromView, insertIntoView } from './helpers/compat-views';

/** Test fixture: put the account on, or take it off, the Enterprise plan through the ownership chokepoint. */
const setEnterprisePlan = (accountId: string, tier: string) =>
  applyAdminOverride(accountId, { tier }, { action: 'test.enterprise_plan.set' });
import { consumeApprovedExecution } from '../connectors/db-deps-gateway';
import { createAccountToken } from '../repositories/account-tokens';
import { mintSetupLink } from '../setup-links/token';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

// Synthetic Supabase sessions for the two browser humans. This lane has no
// reachable GoTrue (SUPABASE_URL points at a dead port on purpose), and five
// repo test files replace the same module — the subjects here are the
// approval-authority rules, not JWT verification.
const HUMAN_SESSION = 'approvals-human-session';
const READER_SESSION = 'approvals-reader-session';
// KRTX-1724: the shared-session cast. A member launches the session and shares
// it with the project, a second member prompts the turn that raises the call,
// and a project manager oversees it.
const LAUNCHER_SESSION = 'approvals-launcher-session';
const PROMPTER_SESSION = 'approvals-prompter-session';
const MANAGER_SESSION = 'approvals-manager-session';
mock.module('../shared/jwt-verify', () => ({
  verifySupabaseJwt: async (token: string) => {
    if (token === HUMAN_SESSION) {
      return { ok: true, userId: humanUserId, email: 'approvals-human@example.test', payload: {} };
    }
    if (token === READER_SESSION) {
      return {
        ok: true,
        userId: readOnlyUserId,
        email: 'approvals-reader@example.test',
        payload: {},
      };
    }
    const shared = sharedCast[token];
    if (shared) {
      return { ok: true, userId: shared, email: `${token}@example.test`, payload: {} };
    }
    return { ok: false, reason: 'invalid-signature' as const };
  },
  decodeSupabaseJwtPayload: () => null,
}));

const { app } = await import('../index');

const minted: string[] = [];
const execIds: string[] = [];
const SESSION = crypto.randomUUID();
const CHAIN_SESSION = crypto.randomUUID();
const CHAIN_PROJECT = crypto.randomUUID();
let ctx: { projectId: string; accountId: string; userId: string } | null = null;
let seeded: SeededProject | null = null;
let secret = '';
let humanToken = HUMAN_SESSION;
let humanUserId = '';
let readOnlyToken = READER_SESSION;
let readOnlyUserId = '';
let priorTier = 'free';
const SHARED_SESSION = crypto.randomUUID();
// The same launcher, but the session came from an API token (the CLI, a
// service account): `origin: 'backend'`, so only managers decide.
const BACKEND_SESSION = crypto.randomUUID();
const launcherUserId = crypto.randomUUID();
const prompterUserId = crypto.randomUUID();
const managerUserId = crypto.randomUUID();
const sharedCast: Record<string, string> = {
  [LAUNCHER_SESSION]: launcherUserId,
  [PROMPTER_SESSION]: prompterUserId,
  [MANAGER_SESSION]: managerUserId,
};
const SHARED_CAST_ROLES: Array<[string, 'member' | 'manager']> = [
  [launcherUserId, 'member'],
  [prompterUserId, 'member'],
  [managerUserId, 'manager'],
];

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
  const rows = await seedProject('approvals');
  seeded = rows;
  // The PAT holder: a real user id with the OWNER role. No Supabase user is
  // needed — PAT authentication resolves the user from the token row itself,
  // which is exactly the CLI path under test here.
  const ownerUserId = crypto.randomUUID();
  ctx = { projectId: rows.project_id, accountId: rows.account_id, userId: ownerUserId };
  await insertIntoView(db, accountMembers, {
    accountId: ctx.accountId,
    userId: ownerUserId,
    accountRole: 'owner',
  });
  const t = await createAccountToken({
    accountId: ctx.accountId,
    userId: ctx.userId,
    name: 'approvals-test',
  });
  minted.push(t.tokenId);
  secret = t.secretKey;
  // The browser human: a second owner with a synthetic Supabase session (the
  // jwt-verify mock below answers for it — this lane has no reachable GoTrue,
  // and five repo test files replace the same module).
  humanUserId = crypto.randomUUID();
  await insertIntoView(db, accountMembers, {
    accountId: ctx.accountId,
    userId: humanUserId,
    accountRole: 'owner',
  });
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: 'approvals-test',
    createdBy: humanUserId,
    visibility: 'private',
  });
  const readOnlyUserIdCandidate = crypto.randomUUID();
  await insertIntoView(db, accountMembers, {
    accountId: ctx.accountId,
    userId: readOnlyUserIdCandidate,
    accountRole: 'member',
  });
  await insertIntoView(db, projectMembers, {
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    userId: readOnlyUserIdCandidate,
    projectRole: 'member',
  });
  readOnlyUserId = readOnlyUserIdCandidate;
  for (const [userId, projectRole] of SHARED_CAST_ROLES) {
    await insertIntoView(db, accountMembers, {
      accountId: ctx.accountId,
      userId,
      accountRole: 'member',
    });
    await insertIntoView(db, projectMembers, {
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      userId,
      projectRole,
    });
  }
  // Launched by a plain member and shared with the whole project.
  await db.insert(projectSessions).values({
    sessionId: SHARED_SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: 'approvals-shared-test',
    createdBy: launcherUserId,
    visibility: 'project',
  });
  await db.insert(projectSessions).values({
    sessionId: BACKEND_SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: 'approvals-backend-test',
    createdBy: launcherUserId,
    origin: 'backend',
    visibility: 'project',
  });
  // The full-trail assertions below need the auditAccess entitlement; flip the
  // enterprise demo on for the suite (restored in afterAll). The unentitled
  // contract has its own dedicated test that toggles it off.
  priorTier = (await getCreditAccount(ctx.accountId))?.tier ?? 'free';
  await setEnterprisePlan(ctx.accountId, 'enterprise');
}, 30_000);

afterAll(async () => {
  for (const id of execIds)
    await db.delete(connectorCalls).where(eq(connectorCalls.executionId, id));
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, SESSION));
  await db
    .delete(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.sessionId, SHARED_SESSION));
  await db
    .delete(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.sessionId, BACKEND_SESSION));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, SHARED_SESSION));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SHARED_SESSION));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, BACKEND_SESSION));
  if (ctx) {
    for (const [userId] of SHARED_CAST_ROLES) {
      await deleteFromView(
        db,
        projectMembers,
        sql`${projectMembers.projectId} = ${ctx.projectId} and ${projectMembers.userId} = ${userId}`,
      );
      await deleteFromView(
        db,
        accountMembers,
        sql`${accountMembers.accountId} = ${ctx.accountId} and ${accountMembers.userId} = ${userId}`,
      );
    }
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local kortix.audit_maintenance = 'on'`);
    await tx
      .delete(auditEvents)
      .where(sql`${auditEvents.sessionId} in (${SESSION}, ${CHAIN_SESSION})`);
  });
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, CHAIN_SESSION));
  await db.delete(projects).where(eq(projects.projectId, CHAIN_PROJECT));
  for (const id of minted)
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${id}`);
  if (ctx) {
    await deleteFromView(
      db,
      accountMembers,
      sql`${accountMembers.accountId} = ${ctx.accountId} and ${accountMembers.userId} = ${ctx.userId}`,
    );
  }
  if (ctx) await setEnterprisePlan(ctx.accountId, priorTier);
  if (seeded) await removeSeeded([seeded]);
  if (ctx && humanUserId) {
    await deleteFromView(
      db,
      accountMembers,
      sql`${accountMembers.accountId} = ${ctx.accountId} and ${accountMembers.userId} = ${humanUserId}`,
    );
  }
  if (ctx && readOnlyUserId) {
    await deleteFromView(
      db,
      projectMembers,
      sql`${projectMembers.projectId} = ${ctx.projectId} and ${projectMembers.userId} = ${readOnlyUserId}`,
    );
    await deleteFromView(
      db,
      accountMembers,
      sql`${accountMembers.accountId} = ${ctx.accountId} and ${accountMembers.userId} = ${readOnlyUserId}`,
    );
  }
}, 30_000);

async function seedPending(
  argsPreviewComplete = true,
  argsPreview: Record<string, unknown> | null = { repo: 'kortix-ai/suna' },
  call: { sessionId: string; actingUserId: string } | null = null,
): Promise<string> {
  if (!ctx) throw new Error('approval integration test has no project context');
  const [row] = await db
    .insert(connectorCalls)
    .values({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      actionPath: 'github.repos.delete',
      actingUserId: call?.actingUserId ?? ctx.userId,
      sessionId: call?.sessionId ?? SESSION,
      status: 'pending_approval',
      risk: null,
      resolvedAt: null, // genuinely awaiting a decision
      resultSummary: {
        ...(argsPreview ? { args_preview: argsPreview } : {}),
        args_preview_complete: argsPreviewComplete,
      },
    })
    .returning({ id: connectorCalls.executionId });
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
const readOnlyGet = (path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${readOnlyToken}` } });
const patGet = (path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${secret}` } });
const patPost = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('approvals inbox + resolution', () => {
  test('session reconstruction returns rows without account or project context, in insertion order', async () => {
    if (!ctx) return;
    await db.insert(projects).values({
      projectId: CHAIN_PROJECT,
      accountId: ctx.accountId,
      name: 'audit-chain-test',
      repoUrl: 'https://example.test/audit-chain-test.git',
    });
    await db.insert(projectSessions).values({
      sessionId: CHAIN_SESSION,
      accountId: ctx.accountId,
      projectId: CHAIN_PROJECT,
      branchName: 'audit-chain-test',
      createdBy: ctx.userId,
      visibility: 'private',
    });
    const chainId = crypto.randomUUID();
    const sourceRecordIds = ['first', 'auth', 'skills', 'last'].map(
      (suffix) => `${chainId}:${suffix}`,
    );
    const inserted = await db
      .insert(auditEvents)
      .values([
        {
          accountId: ctx.accountId,
          projectId: CHAIN_PROJECT,
          sessionId: CHAIN_SESSION,
          action: 'test.session_chain.first',
          resourceType: 'test',
          sourceLedger: 'integration_test',
          sourceRecordId: sourceRecordIds[0],
        },
        {
          accountId: null,
          projectId: CHAIN_PROJECT,
          sessionId: CHAIN_SESSION,
          action: 'auth.login.success',
          resourceType: 'session',
          sourceLedger: 'integration_test',
          sourceRecordId: sourceRecordIds[1],
        },
        {
          accountId: ctx.accountId,
          projectId: null,
          sessionId: CHAIN_SESSION,
          action: 'GET /v1/skills',
          resourceType: 'skill',
          sourceLedger: 'integration_test',
          sourceRecordId: sourceRecordIds[2],
        },
        {
          accountId: ctx.accountId,
          projectId: CHAIN_PROJECT,
          sessionId: CHAIN_SESSION,
          action: 'test.session_chain.last',
          resourceType: 'test',
          sourceLedger: 'integration_test',
          sourceRecordId: sourceRecordIds[3],
        },
      ])
      .returning({ eventId: auditEvents.eventId });

    const response = await patGet(
      `/v1/projects/${CHAIN_PROJECT}/sessions/${CHAIN_SESSION}/audit?limit=1000`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: Array<{
        event_id: string;
        source_record_id: string | null;
        integrity_previous_hash: string | null;
        integrity_hash: string | null;
      }>;
    };
    const projected = body.events.filter((event) =>
      sourceRecordIds.includes(event.source_record_id ?? ''),
    );

    expect(projected.map((event) => event.event_id)).toEqual(
      inserted.map((event) => event.eventId),
    );
    // No chain any more: new rows carry no sequence and no hashes, and the log order is
    // the (time-ordered) event_id.
    expect(projected.every((event) => event.integrity_hash === null)).toBe(true);
    expect(projected.every((event) => event.integrity_previous_hash === null)).toBe(true);
  });

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
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, execId));
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

    const approvalsOnly = await authGet(
      `/v1/projects/${ctx.projectId}/sessions/${SESSION}/audit?include_events=false&limit=1`,
    );
    expect(approvalsOnly.status).toBe(200);
    const approvalsOnlyBody = (await approvalsOnly.json()) as {
      events: unknown[];
      next_cursor: string | null;
      actions: Array<{ execution_id: string }>;
    };
    expect(approvalsOnlyBody.events).toEqual([]);
    expect(approvalsOnlyBody.next_cursor).toBeNull();
    expect(approvalsOnlyBody.actions.some((action) => action.execution_id === execId)).toBe(true);
  });

  test('unentitled account: audit degrades to pending-only (never a 402 — the approval control plane)', async () => {
    if (!ctx) return;
    // A resolved action (history) + a still-pending one.
    const resolvedId = await seedPending();
    await authPost(`/v1/projects/${ctx.projectId}/approvals/${resolvedId}`, {
      decision: 'approve',
    });
    const pendingId = await seedPending();

    await setEnterprisePlan(ctx.accountId, 'free');
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
      await setEnterprisePlan(ctx.accountId, 'enterprise');
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
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, execId));
    expect(after.status).toBe('denied');
    expect(after.resolvedAt).toBeTruthy();
    // The denier is recorded too, so the audit trail attributes the refusal.
    expect(after.approvedBy).toBe(humanUserId);
  });

  test("a deny with a note hands the approver's message to the agent", async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const dn = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'deny',
      note: '  Not yet. Move the meeting to Thursday first.  ',
    });
    expect(dn.status).toBe(200);
    const [after] = await db
      .select()
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, execId));
    expect(after.resultSummary).toMatchObject({
      decision: 'deny',
      decision_note: 'Not yet. Move the meeting to Thursday first.',
    });
    const [callback] = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, `approval-resume:${execId}`));
    const text = (callback?.payload as { text?: string }).text ?? '';
    expect(text).toContain('was denied');
    expect(text).toContain('Not yet. Move the meeting to Thursday first.');
    expect(text).not.toContain('continue without it');
  });

  test('a personal PAT approves like its owner — the CLI resolve path (KRTX-1921)', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const response = await patPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'approve',
    });
    expect(response.status).toBe(200);
    const [after] = await db
      .select()
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, execId));
    // The decision lands exactly as it would from the dashboard: the gate
    // opens, the resolver is the token's user, the agent is resumed.
    expect(after.status).toBe('ok');
    expect(after.approvedBy).toBe(ctx.userId);
    expect(after.resolvedAt).toBeTruthy();
    const [callback] = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, `approval-resume:${execId}`));
    expect(callback?.commandType).toBe('continue_session');
  });

  test('a session-bound PAT (an agent connector token) still cannot approve', async () => {
    if (!ctx) return;
    const sandboxId = crypto.randomUUID();
    await db.insert(sessionSandboxes).values({
      sandboxId,
      sessionId: SESSION,
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      status: 'active',
    });
    const agentToken = await createAccountToken({
      accountId: ctx.accountId,
      userId: ctx.userId,
      projectId: ctx.projectId,
      name: 'approvals-test-agent-connector',
      sessionId: SESSION,
    });
    minted.push(agentToken.tokenId);
    const execId = await seedPending();
    const response = await app.request(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(response.status).toBe(403);
    // The self-approval refusal, not the generic sign-in wall: the token is
    // bound to the very session whose call it tries to approve.
    expect(await response.json()).toMatchObject({
      error: 'An agent cannot resolve its own approval — a human must approve or deny this',
    });
    const [after] = await db
      .select()
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, execId));
    expect(after.status).toBe('pending_approval');
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId));
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

    // The owner's personal PAT is the same human their browser session is —
    // the link read follows the resolve rule (KRTX-1921), so it sees the
    // complete parameters too.
    const patCaller = await app.request(`/v1/approval-links/${token}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(patCaller.status).toBe(200);
    expect(await patCaller.json()).toMatchObject({
      execution_id: execId,
      pending: true,
      review_complete: true,
      args_preview: { repo: 'kortix-ai/suna' },
    });

    const human = await authGet(`/v1/approval-links/${token}`);
    expect(human.status).toBe(200);
    expect(await human.json()).toMatchObject({
      execution_id: execId,
      pending: true,
      review_complete: true,
      args_preview: { repo: 'kortix-ai/suna' },
      approval_context: null,
    });

    await db
      .update(connectorCalls)
      .set({
        resultSummary: {
          args_preview: { repo: 'kortix-ai/suna' },
          args_preview_complete: true,
          approval_context: 'Deletes the scratch repo created in this session',
        },
      })
      .where(eq(connectorCalls.executionId, execId));
    const described = await authGet(`/v1/approval-links/${token}`);
    expect(await described.json()).toMatchObject({
      approval_context: 'Deletes the scratch repo created in this session',
      resolved_preview: null,
      resolved_error: null,
    });

    await db
      .update(connectorCalls)
      .set({
        resultSummary: {
          args_preview: { draft_id: 'r-1' },
          args_preview_complete: true,
          resolved_preview: { to: ['buyer@example.test'], body: 'Hello' },
          resolved_digest: 'd'.repeat(64),
        },
      })
      .where(eq(connectorCalls.executionId, execId));
    const loaded = await (await authGet(`/v1/approval-links/${token}`)).json();
    expect(loaded).toMatchObject({
      resolved_preview: { to: ['buyer@example.test'], body: 'Hello' },
      resolved_error: null,
    });
    expect(loaded).not.toHaveProperty('resolved_digest');
  });

  test('a carried-over approval hands back the content digest the human approved, once', async () => {
    if (!ctx) return;
    const [connector] = await db
      .insert(connectors)
      .values({ accountId: ctx.accountId, projectId: ctx.projectId, slug: 'mail', name: 'Mail', providerType: 'http' })
      .returning({ connectorId: connectors.connectorId });
    const claim = {
      sessionId: SESSION,
      actingUserId: ctx.userId,
      connectorId: connector!.connectorId,
      actionPath: 'mail.drafts.send',
      requestDigest: 'r'.repeat(64),
    };
    const [row] = await db
      .insert(connectorCalls)
      .values({
        accountId: ctx.accountId,
        projectId: ctx.projectId,
        connectorId: claim.connectorId,
        actionPath: claim.actionPath,
        actingUserId: ctx.userId,
        sessionId: SESSION,
        status: 'ok',
        approvedBy: ctx.userId,
        resolvedAt: new Date(),
        requestDigest: claim.requestDigest,
        resultSummary: { decision: 'approve', resolved_digest: 'd'.repeat(64) },
      })
      .returning({ id: connectorCalls.executionId });
    execIds.push(row!.id);

    expect(await consumeApprovedExecution(claim)).toEqual({ resolvedDigest: 'd'.repeat(64), resolvedError: false });
    expect(await consumeApprovedExecution(claim)).toBe(false);
    await db.delete(connectorCalls).where(eq(connectorCalls.executionId, row!.id));
    await db.delete(connectors).where(eq(connectors.connectorId, claim.connectorId));
  });

  test('Review Center exposes parameters only to a human who can resolve the approval', async () => {
    if (!ctx) return;
    const execId = await seedPending();
    const path = `/v1/projects/${ctx.projectId}/review/items`;

    const owner = await authGet(path);
    expect(owner.status).toBe(200);
    const ownerBody = (await owner.json()) as {
      review_items: Array<{ review_item_id: string; detail: Record<string, unknown> }>;
    };
    const ownerItem = ownerBody.review_items.find(
      (item) => item.review_item_id === `call:${execId}`,
    );
    expect(ownerItem?.detail).toMatchObject({
      args_preview: { repo: 'kortix-ai/suna' },
      args_preview_complete: true,
      args_preview_authorized: true,
    });

    // A plain member cannot open the owner's private session, so the item is
    // not listed at all (#10136). On a session shared with the project they
    // see the item, without the parameters they cannot act on.
    const sharedExecId = await seedPending(true, { repo: 'kortix-ai/suna' }, {
      sessionId: SHARED_SESSION,
      actingUserId: launcherUserId,
    });
    const readOnly = await readOnlyGet(path);
    expect(readOnly.status).toBe(200);
    const readOnlyBody = (await readOnly.json()) as {
      review_items: Array<{ review_item_id: string; detail: Record<string, unknown> }>;
    };
    const ids = readOnlyBody.review_items.map((item) => item.review_item_id);
    expect(ids).not.toContain(`call:${execId}`);
    const readOnlyItem = readOnlyBody.review_items.find(
      (item) => item.review_item_id === `call:${sharedExecId}`,
    );
    expect(readOnlyItem).toBeDefined();
    expect(readOnlyItem?.detail).not.toHaveProperty('args_preview');
    expect(readOnlyItem?.detail).toMatchObject({
      args_preview_complete: false,
      args_preview_authorized: false,
    });

    // The owner's personal PAT resolves, so it may see the same parameters
    // the owner's browser session sees — read follows resolve (KRTX-1921).
    const patOwner = await patGet(path);
    expect(patOwner.status).toBe(200);
    const patOwnerBody = (await patOwner.json()) as {
      review_items: Array<{ review_item_id: string; detail: Record<string, unknown> }>;
    };
    const patOwnerItem = patOwnerBody.review_items.find(
      (item) => item.review_item_id === `call:${execId}`,
    );
    expect(patOwnerItem?.detail).toMatchObject({
      args_preview: { repo: 'kortix-ai/suna' },
      args_preview_complete: true,
      args_preview_authorized: true,
    });
  });

  test('a TRUNCATED parameter preview is approvable — the elision is visible', async () => {
    if (!ctx) return;
    // What the builder writes for a call carrying an attachment: the fields are
    // legible, one value is described rather than copied, `complete` is false.
    // This used to 409, leaving Deny as the only possible answer.
    const execId = await seedPending(false, {
      repo: 'kortix-ai/suna',
      attachment: '[400 chars omitted]',
    });
    const approve = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'approve',
    });
    expect(approve.status).toBe(200);
  });

  test('a call with NO recorded parameters blocks approve but still permits deny', async () => {
    if (!ctx) return;
    const execId = await seedPending(false, null);
    const approve = await authPost(`/v1/projects/${ctx.projectId}/approvals/${execId}`, {
      decision: 'approve',
    });
    expect(approve.status).toBe(409);
    expect(await approve.json()).toMatchObject({ code: 'APPROVAL_PREVIEW_UNAVAILABLE' });

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
      .insert(connectorCalls)
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
      .returning({ id: connectorCalls.executionId });
    execIds.push(row.id);

    const response = await authPost(`/v1/projects/${ctx.projectId}/approvals/${row.id}`, {
      decision: 'approve',
    });
    expect(response.status).toBe(500);

    const [after] = await db
      .select()
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, row.id));
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

// KRTX-1724: a client offers Approve / Deny only where the POST would succeed.
// `can_resolve` on GET .../audit, on the session snapshot's audit leg, and on
// the Review Center item must each equal the resolve route's own answer, for
// every caller. Today's rule: a project manager or the session's launcher.
// The prompter of the turn that raised the call is neither, so they wait.
describe('can_resolve is the resolve route verdict, per caller (KRTX-1724)', () => {
  const asCaller = (token: string) => ({
    get: (path: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } }),
    approve: (executionId: string) =>
      app.request(`/v1/projects/${ctx?.projectId}/approvals/${executionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      }),
  });
  const sharedPending = (sessionId = SHARED_SESSION) =>
    seedPending(true, { repo: 'kortix-ai/suna' }, { sessionId, actingUserId: prompterUserId });

  type AuditRow = { execution_id: string; can_resolve: boolean; resolvers: string | null };
  type ReviewRow = {
    review_item_id: string;
    status: string;
    can_resolve?: boolean;
    resolvers?: string | null;
  };

  /** One fresh pending call per caller: a resolved call answers 409. */
  async function readsAndResolve(token: string, sessionId = SHARED_SESSION) {
    if (!ctx) throw new Error('approval integration test has no project context');
    const execId = await sharedPending(sessionId);
    const caller = asCaller(token);
    const base = `/v1/projects/${ctx.projectId}`;

    const audit = await caller.get(`${base}/sessions/${sessionId}/audit?include_events=false`);
    expect(audit.status).toBe(200);
    const auditRow = ((await audit.json()) as { actions: AuditRow[] }).actions.find(
      (action) => action.execution_id === execId,
    );

    const snapshot = await caller.get(`${base}/sessions/${sessionId}/snapshot?transcript=0`);
    expect(snapshot.status).toBe(200);
    const snapshotBody = (await snapshot.json()) as {
      audit: { known: boolean; actions?: AuditRow[] };
    };
    expect(snapshotBody.audit.known).toBe(true);
    const snapshotRow = snapshotBody.audit.actions?.find(
      (action) => action.execution_id === execId,
    );

    const review = await caller.get(`${base}/review/items`);
    expect(review.status).toBe(200);
    const reviewItem = ((await review.json()) as { review_items: ReviewRow[] }).review_items.find(
      (item) => item.review_item_id === `call:${execId}`,
    );

    // The approval page reads through the same caller and target.
    const { token: linkToken } = mintSetupLink(ctx.projectId, {
      kind: 'approval',
      executionId: execId,
      sessionId,
    });
    const link = await caller.get(`/v1/approval-links/${linkToken}`);

    const resolve = await caller.approve(execId);
    return { auditRow, snapshotRow, reviewItem, link, resolve };
  }

  const cases: Array<[string, string, boolean]> = [
    ['the account owner (a manager)', HUMAN_SESSION, true],
    ['a project manager', MANAGER_SESSION, true],
    ['the member who launched the session', LAUNCHER_SESSION, true],
    ['the member who prompted the turn, not the launcher', PROMPTER_SESSION, false],
    ['a member who only views the session', READER_SESSION, false],
  ];

  for (const [who, token, resolves] of cases) {
    test(`${who}: can_resolve ${resolves} on every read, and the POST agrees`, async () => {
      if (!ctx) return;
      const { auditRow, snapshotRow, reviewItem, link, resolve } = await readsAndResolve(token);
      expect(auditRow?.can_resolve).toBe(resolves);
      expect(snapshotRow?.can_resolve).toBe(resolves);
      expect(reviewItem?.can_resolve).toBe(resolves);
      // A person started this session: managers and that launcher decide.
      expect(auditRow?.resolvers).toBe('managers_and_launcher');
      expect(snapshotRow?.resolvers).toBe('managers_and_launcher');
      expect(reviewItem?.resolvers).toBe('managers_and_launcher');
      // A resolver finds the call under Needs you; everyone else under Waiting.
      expect(reviewItem?.status).toBe(resolves ? 'needs_you' : 'waiting');
      expect(link.status).toBe(resolves ? 200 : 403);
      expect(resolve.status).toBe(resolves ? 200 : 403);
    });
  }

  // `created_by` of a session started with an API token names the wrapper, so
  // the launcher half of the rule never applies there. Every read must say so,
  // or the launcher gets Approve / Deny that the POST answers with 403.
  const backendCases: Array<[string, string, boolean]> = [
    ['a project manager', MANAGER_SESSION, true],
    ['the account owner (a manager)', HUMAN_SESSION, true],
    ['the member whose API token started it', LAUNCHER_SESSION, false],
  ];

  for (const [who, token, resolves] of backendCases) {
    test(`origin backend, ${who}: can_resolve ${resolves}, managers decide`, async () => {
      if (!ctx) return;
      const { auditRow, snapshotRow, reviewItem, link, resolve } = await readsAndResolve(
        token,
        BACKEND_SESSION,
      );
      expect(auditRow).toMatchObject({ can_resolve: resolves, resolvers: 'managers' });
      expect(snapshotRow).toMatchObject({ can_resolve: resolves, resolvers: 'managers' });
      expect(reviewItem).toMatchObject({
        can_resolve: resolves,
        resolvers: 'managers',
        status: resolves ? 'needs_you' : 'waiting',
      });
      expect(link.status).toBe(resolves ? 200 : 403);
      expect(resolve.status).toBe(resolves ? 200 : 403);
    });
  }

  test('an agent token bound to the session reads can_resolve false and is refused', async () => {
    if (!ctx) return;
    const sandboxId = crypto.randomUUID();
    await db.insert(sessionSandboxes).values({
      sandboxId,
      sessionId: SHARED_SESSION,
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      status: 'active',
    });
    // Minted by the account owner: the owner's role on the token must not make
    // the agent its own approver.
    const agentToken = await createAccountToken({
      accountId: ctx.accountId,
      userId: ctx.userId,
      projectId: ctx.projectId,
      name: 'approvals-test-shared-agent',
      sessionId: SHARED_SESSION,
    });
    minted.push(agentToken.tokenId);
    const execId = await sharedPending();
    const agent = asCaller(agentToken.secretKey);

    const audit = await agent.get(
      `/v1/projects/${ctx.projectId}/sessions/${SHARED_SESSION}/audit?include_events=false`,
    );
    expect(audit.status).toBe(200);
    const row = (
      (await audit.json()) as { actions: Array<{ execution_id: string; can_resolve: boolean }> }
    ).actions.find((action) => action.execution_id === execId);
    expect(row?.can_resolve).toBe(false);

    const resolve = await agent.approve(execId);
    expect(resolve.status).toBe(403);
    expect(await resolve.json()).toMatchObject({ code: 'APPROVAL_REQUIRES_HUMAN' });
  });

  test('a decided call carries can_resolve false, even for a manager', async () => {
    if (!ctx) return;
    const execId = await sharedPending();
    const owner = asCaller(HUMAN_SESSION);
    expect((await owner.approve(execId)).status).toBe(200);
    const audit = await owner.get(
      `/v1/projects/${ctx.projectId}/sessions/${SHARED_SESSION}/audit?include_events=false`,
    );
    expect(audit.status).toBe(200);
    const row = (
      (await audit.json()) as {
        actions: Array<{ execution_id: string; can_resolve: boolean; status: string }>;
      }
    ).actions.find((action) => action.execution_id === execId);
    expect(row).toMatchObject({ status: 'ok', can_resolve: false });
  });
});
