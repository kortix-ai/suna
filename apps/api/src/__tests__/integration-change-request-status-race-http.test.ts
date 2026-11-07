/**
 * A change request's close and reopen race a merge (real HTTP routes, real
 * PostgreSQL). The routes read the request, check its status in code, and
 * used to write `WHERE cr_id = ?` only: a merge that committed between the
 * read and the write was overwritten, and a merged request read `closed` or
 * `open` while its code sat on the base branch.
 *
 * Each test holds the row lock with a second connection that marks the
 * request merged, lets the route block on it, then commits: the exact
 * interleaving. The routes now write through `CHANGE_REQUEST_TRANSITIONS`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, changeRequests, projectMembers, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { interleave } from './helpers/interleave';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const minted: string[] = [];
let number = 400;

const post = (path: string, secret: string) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: '{}',
  });

async function managerToken(): Promise<string> {
  const t = await createAccountToken({ accountId: ACCOUNT, userId: MANAGER, projectId: PROJECT, name: 'cr-race' });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function newRequest(status: 'open' | 'closed'): Promise<{ crId: string; number: number }> {
  const n = ++number;
  const [row] = await db
    .insert(changeRequests)
    .values({
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: n,
      title: `race ${n}`,
      baseRef: 'main',
      headRef: `cr-${n}`,
      status,
      createdBy: MANAGER,
    })
    .returning({ crId: changeRequests.crId });
  return { crId: row!.crId, number: n };
}

const markMerged = (crId: string) => (tx: { query: (q: string, v: unknown[]) => Promise<unknown> }) =>
  tx.query(
    `UPDATE kortix.change_requests SET status = 'merged', merged_at = now(), merge_commit_sha = 'abc123' WHERE cr_id = $1`,
    [crId],
  );

async function statusOf(crId: string): Promise<string | undefined> {
  const [row] = await db.select({ status: changeRequests.status }).from(changeRequests).where(eq(changeRequests.crId, crId));
  return row?.status;
}

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'cr-status-race-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'cr-status-race-test-project',
    repoUrl: 'https://example.test/cr-status-race.git',
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

describe('change request close and reopen never overwrite a merge that raced them', () => {
  test('a close that read `open` before a merge committed answers 409 and leaves it merged', async () => {
    const secret = await managerToken();
    const cr = await newRequest('open');
    const res = await interleave(
      markMerged(cr.crId),
      async () => post(`/v1/projects/${PROJECT}/change-requests/${cr.crId}/close`, secret),
      'change_requests',
    );
    expect(res.status).toBe(409);
    expect(await statusOf(cr.crId)).toBe('merged');
  });

  test('a reopen that read `closed` before a merge committed answers 409 and leaves it merged', async () => {
    const secret = await managerToken();
    const cr = await newRequest('closed');
    const res = await interleave(
      markMerged(cr.crId),
      async () => post(`/v1/projects/${PROJECT}/change-requests/${cr.crId}/reopen`, secret),
      'change_requests',
    );
    expect(res.status).toBe(409);
    expect(await statusOf(cr.crId)).toBe('merged');
  });

  test('close then reopen of an unraced request still apply', async () => {
    const secret = await managerToken();
    const cr = await newRequest('open');
    expect((await post(`/v1/projects/${PROJECT}/change-requests/${cr.crId}/close`, secret)).status).toBe(200);
    expect(await statusOf(cr.crId)).toBe('closed');
    // A second close of a closed request answers with the close, as before.
    expect((await post(`/v1/projects/${PROJECT}/change-requests/${cr.crId}/close`, secret)).status).toBe(200);
    expect((await post(`/v1/projects/${PROJECT}/change-requests/${cr.crId}/reopen`, secret)).status).toBe(200);
    expect(await statusOf(cr.crId)).toBe('open');
  });
});
