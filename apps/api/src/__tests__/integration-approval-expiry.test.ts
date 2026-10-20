/**
 * Approval expiry (real Postgres, in-process app). A pending connector approval
 * past `expires_at` leaves every pending reader, refuses a decision with 409
 * APPROVAL_EXPIRED, reads as `expired` by id, and the worker tick closes it
 * (status `expired`, resolved_at, one audit event). The clock is the database's:
 * rows are seeded with `expires_at` in the past, nothing sleeps.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  auditEvents,
  connectorCalls,
  connectorProjectSettings,
  projectSessions,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { extractProjectPolicies } from '../projects/policies';
import type { ApprovalCaller } from '../projects/lib/approval-authority';
import { getInboxItem, listInboxItems, reviewSummary } from '../projects/review-items';
import { flushAuditEvents } from '../shared/audit';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const HUMAN_SESSION = 'approval-expiry-human-session';
const humanUserId = crypto.randomUUID();
mock.module('../shared/jwt-verify', () => ({
  verifySupabaseJwt: async (token: string) =>
    token === HUMAN_SESSION
      ? { ok: true, userId: humanUserId, email: 'approval-expiry@example.test', payload: {} }
      : { ok: false, reason: 'invalid-signature' as const },
  decodeSupabaseJwtPayload: () => null,
}));

const { app } = await import('../index');
const { runApprovalExpiryTick } = await import('../workers/approval-expiry-worker');
const { makeDbGatewayDeps } = await import('../connectors/db-deps-gateway');

let seeded: SeededProject;
let sessionId = '';
let expiredId = '';
let liveId = '';

const asOwner = async (): Promise<ApprovalCaller> => ({
  isManager: true,
  callerUserId: humanUserId,
  callerAuthType: 'supabase',
  callerCredentialKind: 'jwt',
  callerSessionId: null,
});
const FULL_VIEW = { where: () => undefined, allows: async () => true };
const authed = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${HUMAN_SESSION}`, 'Content-Type': 'application/json' },
  });

async function seedPending(expiresAt: string): Promise<string> {
  const [row] = await db
    .insert(connectorCalls)
    .values({
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      actionPath: 'github.repos.delete',
      actingUserId: humanUserId,
      sessionId,
      status: 'pending_approval',
      resultSummary: { args_preview: { repo: 'example/repo' }, args_preview_complete: true },
      expiresAt: sql`${sql.raw(expiresAt)}`,
    })
    .returning({ id: connectorCalls.executionId });
  return row.id;
}

beforeAll(async () => {
  seeded = await seedProject('approval-expiry');
  await insertIntoView(db, accountMembers, {
    accountId: seeded.account_id,
    userId: humanUserId,
    accountRole: 'owner',
  });
  sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    branchName: 'approval-expiry',
    createdBy: humanUserId,
  });
  expiredId = await seedPending(`now() - interval '1 minute'`);
  liveId = await seedPending(`now() + interval '1 hour'`);
}, 30_000);

afterAll(async () => {
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, seeded.project_id));
  await db.delete(connectorProjectSettings).where(eq(connectorProjectSettings.projectId, seeded.project_id));
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local kortix.audit_maintenance = 'on'`);
    await tx.delete(auditEvents).where(eq(auditEvents.projectId, seeded.project_id));
  });
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, sessionId));
  await deleteFromView(
    db,
    accountMembers,
    sql`${accountMembers.accountId} = ${seeded.account_id} and ${accountMembers.userId} = ${humanUserId}`,
  );
  await removeSeeded([seeded]);
}, 30_000);

describe('approval expiry', () => {
  test('GET /approvals lists only the unexpired call, with its expires_at', async () => {
    const res = await authed(`/v1/projects/${seeded.project_id}/approvals`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<{ execution_id: string; expires_at: string | null }> };
    expect(body.approvals.map((a) => a.execution_id)).toEqual([liveId]);
    expect(Date.parse(body.approvals[0].expires_at ?? '')).toBeGreaterThan(Date.now());
  });

  test('GET /approvals/needs-input counts only the unexpired call', async () => {
    const res = await authed(`/v1/projects/${seeded.project_id}/approvals/needs-input`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 1, sessions: { [sessionId]: 1 } });
  });

  test('the review inbox and summary skip the expired call; by id it reads expired', async () => {
    const page = await listInboxItems(seeded.project_id, {}, asOwner, FULL_VIEW);
    expect(page.items.map((item) => item.review_item_id)).toEqual([`call:${liveId}`]);
    expect((page.items[0] as { expires_at?: string | null }).expires_at).toBeString();
    const summary = await reviewSummary(seeded.project_id, asOwner, FULL_VIEW);
    expect(summary.needs_you_total).toBe(1);
    const item = await getInboxItem(seeded.project_id, `call:${expiredId}`, asOwner, FULL_VIEW);
    expect(item).toMatchObject({ status: 'expired', can_resolve: false });
  });

  test('POST /approvals/:executionId on an expired call returns 409 APPROVAL_EXPIRED', async () => {
    const res = await authed(`/v1/projects/${seeded.project_id}/approvals/${expiredId}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'APPROVAL_EXPIRED' });
    const [row] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, expiredId));
    expect(row.status).toBe('pending_approval');
  });

  test('the worker tick closes the expired call, audits it, and leaves the live one', async () => {
    expect(await runApprovalExpiryTick()).toBeGreaterThanOrEqual(1);
    const [expired] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, expiredId));
    expect(expired.status).toBe('expired');
    expect(expired.resolvedAt).toBeInstanceOf(Date);
    const [live] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, liveId));
    expect(live.status).toBe('pending_approval');
    await flushAuditEvents();
    const events = await db
      .select({ action: auditEvents.action, outcome: auditEvents.outcome })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, expiredId));
    expect(events).toContainEqual({ action: 'connector.approval.expired', outcome: 'expired' });
    // Already expired by the worker: the decision is still refused as expired.
    const res = await authed(`/v1/projects/${seeded.project_id}/approvals/${expiredId}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'APPROVAL_EXPIRED' });
  });

  test('a new pending row expires after the project approvals.ttl, else 24 h', async () => {
    const deps = makeDbGatewayDeps({
      userId: humanUserId,
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      sessionId,
      subject: { userId: humanUserId, groupIds: [] },
    } as Parameters<typeof makeDbGatewayDeps>[0]);
    const record = () =>
      deps.recordExecution({
        accountId: seeded.account_id,
        projectId: seeded.project_id,
        connectorId: null,
        connectionId: null,
        actionPath: 'github.repos.delete',
        actingUserId: humanUserId,
        sessionId,
        status: 'pending_approval',
        risk: null,
        resultSummary: null,
      });
    const windowSeconds = async (id: string | null) => {
      const [row] = await db
        .select({ s: sql<number>`extract(epoch from ${connectorCalls.expiresAt} - ${connectorCalls.createdAt})::int` })
        .from(connectorCalls)
        .where(eq(connectorCalls.executionId, id ?? ''));
      return row.s;
    };
    expect(await windowSeconds(await record())).toBe(24 * 3600);
    const ttl = extractProjectPolicies({ path: 'kortix.yaml', raw: { approvals: { ttl: '4h' } } } as never)
      .approvalTtlSeconds;
    await db.insert(connectorProjectSettings).values({ projectId: seeded.project_id, approvalTtlSeconds: ttl });
    expect(await windowSeconds(await record())).toBe(4 * 3600);
  });
});
