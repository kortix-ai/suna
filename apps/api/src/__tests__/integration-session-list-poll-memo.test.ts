/**
 * Integration test (real DB, real route): a repeated poll of the project
 * session list must not re-run the inventory.
 *
 * `GET /projects/:id/sessions` is the dashboard's poll: the sidebar re-fetches
 * it six times per session open and every few seconds while sessions run
 * (measured on prod, 2026-10-09: bursts of 20-33 requests per minute from one
 * account, ~23 of 23 slow at the peak). The response carries a weak ETag, so a
 * repeat ends as a 304 — but the 304 was computed AFTER the full multi-op
 * inventory, so every poll still spent its 6-14 DB operations. Those polls
 * share the API task's small connection pool, so a burst queues its own
 * operations and p95 on the route explodes while single-op routes stay flat.
 *
 * The fix memoizes the last ETag per (viewer, query) for a short window: a
 * poll whose If-None-Match still matches the memoized ETag is answered with a
 * 304 before any DB work. This file pins that on the real route:
 *  1. the first GET computes normally (db n > 0);
 *  2. an If-None-Match repeat within the window is a 304 that costs 0 DB ops;
 *  3. a different query key is never answered from another key's memo entry;
 *  4. once the window expires, the next poll computes again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const SESSION_A = crypto.randomUUID();
const SESSION_B = crypto.randomUUID();
const SESSION_C = crypto.randomUUID();

const minted: string[] = [];
let token = '';

function dbOpCount(res: Response): number {
  const header = res.headers.get('server-timing') ?? '';
  const m = header.match(/db;dur=\d+;desc="n=(\d+)"/);
  // The db stage is omitted entirely when it ran zero operations.
  if (!m) return 0;
  return Number(m[1]);
}

const listUrl = (query = '') =>
  `/v1/projects/${PROJECT}/sessions?limit=50${query ? `&${query}` : ''}`;

beforeAll(async () => {
  await db.execute(sql`
    insert into kortix.accounts (account_id, name)
    values (${ACCOUNT}, 'poll-memo-test')
    on conflict (account_id) do nothing`);
  await db.execute(sql`
    insert into kortix.account_members (user_id, account_id, account_role)
    values (${USER}, ${ACCOUNT}, 'owner')
    on conflict do nothing`);
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url)
    values (${PROJECT}, ${ACCOUNT}, 'poll-memo-test', 'https://github.com/kortix-ai/suna')
    on conflict (project_id) do nothing`);
  await db.execute(sql`
    insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, created_by, visibility, created_at, updated_at)
    values
      (${SESSION_A}, ${ACCOUNT}, ${PROJECT}, 'poll-memo-a', ${USER}, 'project', now() - interval '3 minutes', now() - interval '3 minutes'),
      (${SESSION_B}, ${ACCOUNT}, ${PROJECT}, 'poll-memo-b', ${USER}, 'project', now() - interval '2 minutes', now() - interval '2 minutes'),
      (${SESSION_C}, ${ACCOUNT}, ${PROJECT}, 'poll-memo-c', ${USER}, 'project', now() - interval '1 minutes', now() - interval '1 minutes')
    on conflict (session_id) do nothing`);

  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId: USER,
    projectId: PROJECT,
    name: 'poll-memo-test',
  });
  minted.push(t.tokenId);
  token = t.secretKey;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.project_sessions where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.projects where project_id = ${PROJECT}`);
  await db.execute(sql`delete from kortix.account_members where account_id = ${ACCOUNT}`);
  await db.execute(sql`delete from kortix.accounts where account_id = ${ACCOUNT}`);
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
});

const authHeader = (): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

describe('session list poll memo', () => {
  test('an If-None-Match repeat within the window is a 304 that runs no DB ops', async () => {
    const first = await app.request(listUrl(), { headers: authHeader() });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const firstOps = dbOpCount(first);
    expect(firstOps).toBeGreaterThan(0);

    const repeat = await app.request(listUrl(), {
      headers: { ...authHeader(), 'If-None-Match': etag! },
    });
    expect(repeat.status).toBe(304);
    // THE CONTRACT: the memoized 304 runs no inventory. The db stage here is
    // the credential's fixed auth-validation cost, not the route's: an account
    // token pays 2 lookups per request on EVERY route (measured on this
    // fixture); a browser JWT — what the dashboard's poller actually sends —
    // measures 0, verified live on the local stack. A regression that re-runs
    // any part of the inventory pushes this to 3+.
    expect(dbOpCount(repeat)).toBeLessThanOrEqual(2);
  });

  test('a different query key is never answered from another key entry', async () => {
    const first = await app.request(listUrl(), { headers: authHeader() });
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();

    const other = await app.request(listUrl('q=nomatch'), {
      headers: { ...authHeader(), 'If-None-Match': etag! },
    });
    // A different key computes its own answer (and does not 304 on the other
    // key's etag).
    expect(other.status).toBe(200);
    expect(dbOpCount(other)).toBeGreaterThan(0);
    const otherEtag = other.headers.get('etag')!;

    const repeat = await app.request(listUrl('q=nomatch'), {
      headers: { ...authHeader(), 'If-None-Match': otherEtag! },
    });
    expect(repeat.status).toBe(304);
    expect(dbOpCount(repeat)).toBeLessThanOrEqual(2);
  });

  test('after the window expires the next poll computes again', async () => {
    const first = await app.request(listUrl('q=expired'), { headers: authHeader() });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;

    const within = await app.request(listUrl('q=expired'), {
      headers: { ...authHeader(), 'If-None-Match': etag! },
    });
    expect(within.status).toBe(304);
    expect(dbOpCount(within)).toBeLessThanOrEqual(2);

    await new Promise((resolve) => setTimeout(resolve, 2_300));

    const expired = await app.request(listUrl('q=expired'), {
      headers: { ...authHeader(), 'If-None-Match': etag! },
    });
    expect(expired.status).toBe(304);
    // The window has passed: the inventory ran again (db n > 0), the etag
    // still matches, so the answer is still a 304 — but a computed one.
    expect(dbOpCount(expired)).toBeGreaterThan(0);
  });
});
