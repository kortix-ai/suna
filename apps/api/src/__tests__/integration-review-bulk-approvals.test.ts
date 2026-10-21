/**
 * Bulk act across Review Center sources (real Postgres, in-process app).
 * `POST /review/bulk` decides `call:` ids through the single resolve path, one
 * id at a time, and answers one `results` entry per requested id in request
 * order: native ids update, a live call resolves, an expired call reads
 * `expired`, a call with nothing to review reads `preview_unavailable`, a
 * decided call reads `already_resolved`, a `cr:` id and a call under a verdict
 * other than approve/reject read `not_bulk_actionable`, an unknown call reads
 * `not_found`, and a caller who is neither manager nor launcher reads
 * `forbidden`. More than 50 ids → 400.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  auditEvents,
  connectorCalls,
  projectMembers,
  projectSessions,
  reviewItems,
  sessionLifecycleCommands,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { insertReviewItem } from '../projects/review-items';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER_SESSION = 'review-bulk-owner-session';
const MEMBER_SESSION = 'review-bulk-member-session';
const ownerUserId = crypto.randomUUID();
const memberUserId = crypto.randomUUID();
mock.module('../shared/jwt-verify', () => ({
  verifySupabaseJwt: async (token: string) =>
    token === OWNER_SESSION
      ? { ok: true, userId: ownerUserId, email: 'review-bulk-owner@example.test', payload: {} }
      : token === MEMBER_SESSION
        ? { ok: true, userId: memberUserId, email: 'review-bulk-member@example.test', payload: {} }
        : { ok: false, reason: 'invalid-signature' as const },
  decodeSupabaseJwtPayload: () => null,
}));

const { app } = await import('../index');

let seeded: SeededProject;
let sessionId = '';

const bulk = (token: string, body: unknown) =>
  app.request(`/v1/projects/${seeded.project_id}/review/bulk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function seedCall(opts: { expiresAt?: string; reviewable?: boolean } = {}): Promise<string> {
  const [row] = await db
    .insert(connectorCalls)
    .values({
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      actionPath: 'github.issues.create',
      actingUserId: ownerUserId,
      sessionId,
      status: 'pending_approval',
      resultSummary:
        opts.reviewable === false
          ? {}
          : { args_preview: { title: 'synthetic' }, args_preview_complete: true },
      expiresAt: sql`${sql.raw(opts.expiresAt ?? `now() + interval '1 hour'`)}`,
    })
    .returning({ id: connectorCalls.executionId });
  return row.id;
}

const statusOf = async (executionId: string) =>
  (await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, executionId)))[0].status;

beforeAll(async () => {
  seeded = await seedProject('review-bulk');
  await insertIntoView(db, accountMembers, {
    accountId: seeded.account_id,
    userId: ownerUserId,
    accountRole: 'owner',
  });
  await insertIntoView(db, accountMembers, {
    accountId: seeded.account_id,
    userId: memberUserId,
    accountRole: 'member',
  });
  await insertIntoView(db, projectMembers, {
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    userId: memberUserId,
    projectRole: 'member',
  });
  sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    branchName: 'review-bulk',
    createdBy: ownerUserId,
  });
}, 30_000);

afterAll(async () => {
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, seeded.project_id));
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, seeded.project_id));
  await db.delete(reviewItems).where(eq(reviewItems.projectId, seeded.project_id));
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local kortix.audit_maintenance = 'on'`);
    await tx.delete(auditEvents).where(eq(auditEvents.projectId, seeded.project_id));
  });
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, sessionId));
  for (const userId of [ownerUserId, memberUserId]) {
    await deleteFromView(
      db,
      accountMembers,
      sql`${accountMembers.accountId} = ${seeded.account_id} and ${accountMembers.userId} = ${userId}`,
    );
  }
  await removeSeeded([seeded]);
}, 30_000);

describe('POST /review/bulk across sources', () => {
  test('approve: one result per id, in request order, each source decided on its own', async () => {
    const native = await insertReviewItem({
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      kind: 'output',
      title: 'synthetic output',
      createdBy: ownerUserId,
    });
    const live = await seedCall();
    const expired = await seedCall({ expiresAt: `now() - interval '1 minute'` });
    const blind = await seedCall({ reviewable: false });
    const ids = [
      native.reviewItemId,
      `call:${live}`,
      `call:${expired}`,
      `cr:${crypto.randomUUID()}`,
      `call:${crypto.randomUUID()}`,
      `call:${blind}`,
      `call:${live}`,
    ];

    const res = await bulk(OWNER_SESSION, { ids, verdict: 'approve' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number; review_items: unknown[]; results: unknown[] };
    expect(body.updated).toBe(1);
    expect(body.review_items).toHaveLength(1);
    expect(body.results).toEqual([
      { id: native.reviewItemId, ok: true },
      { id: `call:${live}`, ok: true },
      { id: `call:${expired}`, ok: false, code: 'expired' },
      { id: ids[3], ok: false, code: 'not_bulk_actionable' },
      { id: ids[4], ok: false, code: 'not_found' },
      { id: `call:${blind}`, ok: false, code: 'preview_unavailable' },
      { id: `call:${live}`, ok: false, code: 'already_resolved' },
    ]);
    expect(await statusOf(live)).toBe('ok');
    expect(await statusOf(expired)).toBe('pending_approval');
    expect(await statusOf(blind)).toBe('pending_approval');
    const resumes = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, `approval-resume:${live}`));
    expect(resumes).toHaveLength(1);
  });

  test('reject denies a call', async () => {
    const call = await seedCall();
    const res = await bulk(OWNER_SESSION, { ids: [`call:${call}`], verdict: 'reject' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 0, results: [{ id: `call:${call}`, ok: true }] });
    expect(await statusOf(call)).toBe('denied');
  });

  test('dismiss on a call is not bulk-actionable and leaves it pending', async () => {
    const call = await seedCall();
    const res = await bulk(OWNER_SESSION, { ids: [`call:${call}`], verdict: 'dismiss' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      results: [{ id: `call:${call}`, ok: false, code: 'not_bulk_actionable' }],
    });
    expect(await statusOf(call)).toBe('pending_approval');
  });

  test('a member who is neither manager nor launcher gets forbidden per call', async () => {
    const call = await seedCall();
    const res = await bulk(MEMBER_SESSION, { ids: [`call:${call}`], verdict: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      results: [{ id: `call:${call}`, ok: false, code: 'forbidden' }],
    });
    expect(await statusOf(call)).toBe('pending_approval');
  });

  test('more than 50 ids → 400', async () => {
    const ids = Array.from({ length: 51 }, () => `call:${crypto.randomUUID()}`);
    const res = await bulk(OWNER_SESSION, { ids, verdict: 'approve' });
    expect(res.status).toBe(400);
  });
});
