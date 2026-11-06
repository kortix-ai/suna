/**
 * A project access request's approve and reject race (real HTTP routes, real
 * PostgreSQL). Both routes read the request, checked `pending` in code, and
 * wrote `WHERE request_id = ?` only. The approve granted the project role
 * BEFORE its write, so an approve that raced a reject left the requester
 * with access while the request read `rejected`, or a reject overwrote an
 * approval whose role stayed granted.
 *
 * Each test holds the row lock with a second connection that commits the
 * other verdict, lets the route block on it, then commits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectAccessRequests, projectMembers, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { interleave } from './helpers/interleave';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const minted: string[] = [];

const post = (path: string, secret: string, body: unknown = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function managerToken(): Promise<string> {
  const t = await createAccountToken({ accountId: ACCOUNT, userId: MANAGER, projectId: PROJECT, name: 'access-race' });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function newRequest(): Promise<{ requestId: string; requester: string }> {
  const requester = crypto.randomUUID();
  const [row] = await db
    .insert(projectAccessRequests)
    .values({
      accountId: ACCOUNT,
      projectId: PROJECT,
      requesterUserId: requester,
      requesterEmail: `requester-${requester.slice(0, 8)}@example.test`,
    })
    .returning({ requestId: projectAccessRequests.requestId });
  return { requestId: row!.requestId, requester };
}

const commitVerdict = (requestId: string, status: 'approved' | 'rejected') =>
  (tx: { query: (q: string, v: unknown[]) => Promise<unknown> }) =>
    tx.query(
      `UPDATE kortix.project_access_requests SET status = $2, reviewed_at = now() WHERE request_id = $1`,
      [requestId, status],
    );

async function statusOf(requestId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: projectAccessRequests.status })
    .from(projectAccessRequests)
    .where(eq(projectAccessRequests.requestId, requestId));
  return row?.status;
}

async function hasProjectRole(userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, PROJECT), eq(projectMembers.userId, userId)));
  return rows.length > 0;
}

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'access-request-race-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'access-request-race-test-project',
    repoUrl: 'https://example.test/access-race.git',
  });
  await insertIntoView(db, accountMembers, [
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
  ]);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a project access request is reviewed once', () => {
  test('an approve that read `pending` before a reject committed answers 409 and grants nothing', async () => {
    const secret = await managerToken();
    const req = await newRequest();
    const res = await interleave(
      commitVerdict(req.requestId, 'rejected'),
      async () => post(`/v1/projects/${PROJECT}/access-requests/${req.requestId}/approve`, secret),
      'project_access_requests',
    );
    expect(res.status).toBe(409);
    expect(await statusOf(req.requestId)).toBe('rejected');
    expect(await hasProjectRole(req.requester)).toBe(false);
  });

  test('a reject that read `pending` before an approve committed answers 409 and keeps the approval', async () => {
    const secret = await managerToken();
    const req = await newRequest();
    const res = await interleave(
      commitVerdict(req.requestId, 'approved'),
      async () => post(`/v1/projects/${PROJECT}/access-requests/${req.requestId}/reject`, secret),
      'project_access_requests',
    );
    expect(res.status).toBe(409);
    expect(await statusOf(req.requestId)).toBe('approved');
  });

  test('an unraced approve grants the role and reads approved', async () => {
    const secret = await managerToken();
    const req = await newRequest();
    const res = await post(`/v1/projects/${PROJECT}/access-requests/${req.requestId}/approve`, secret);
    expect(res.status, await res.text()).toBe(200);
    expect(await statusOf(req.requestId)).toBe('approved');
    expect(await hasProjectRole(req.requester)).toBe(true);
  });
});
