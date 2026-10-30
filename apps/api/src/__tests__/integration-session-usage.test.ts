/**
 * Integration test (real local DB): sessionUsageTree — what a session and every
 * session it started cost, in USD, from the gateway's request ledger.
 *
 * Every row is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projectSessions, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { SESSION_USAGE_MAX_DEPTH, sessionUsageTree } from '../projects/lib/session-usage';
import { db } from '../shared/db';

const tag = crypto.randomUUID().slice(0, 8);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const sid = (id: string) => `${id}-${tag}`;
const T0 = Date.now() - 60 * 60 * 1000;

type Row = typeof projectSessions.$inferSelect;

async function session(id: string, parent: string | null, input: { at?: number; name?: string; deleted?: boolean; projectId?: string } = {}) {
  await db.insert(projectSessions).values({
    sessionId: sid(id), accountId: ACCOUNT, projectId: input.projectId ?? PROJECT, branchName: sid(id), createdBy: OWNER,
    parentSessionId: parent ? sid(parent) : null,
    metadata: { ...(input.name ? { name: input.name } : {}), ...(input.deleted ? { deletedAt: new Date().toISOString() } : {}) },
    createdAt: new Date(T0 + (input.at ?? 0) * 1000),
  });
}

async function request(session: string, input: { kortix?: number; provider?: number; ok?: boolean; input?: number; output?: number; projectId?: string }) {
  const byok = input.provider !== undefined;
  await db.insert(gatewayRequestLogs).values({
    requestId: `req-${crypto.randomUUID()}`, accountId: ACCOUNT, projectId: input.projectId ?? PROJECT,
    sessionId: sid(session), requestedModel: 'test-model', resolvedModel: 'test-model', provider: 'kortix',
    status: input.ok === false ? 429 : 200, ok: input.ok !== false,
    finalCost: String(input.kortix ?? 0), upstreamCost: String(input.provider ?? 0),
    billingMode: byok ? 'none' : 'credits',
    inputTokens: input.input ?? 0, outputTokens: input.output ?? 0,
  });
}

async function rowOf(id: string): Promise<Row> {
  const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sid(id)));
  return row;
}

/** Every requested row, except the ids in `hidden`. */
const seeAllBut = (...hidden: string[]) => async (ids: string[]) => {
  const rows = await db.select().from(projectSessions).where(inArray(projectSessions.sessionId, ids));
  return new Map(rows.filter((r) => !hidden.map(sid).includes(r.sessionId)).map((r) => [r.sessionId, r]));
};

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role) values
      (${OWNER}::uuid, ${`owner-${tag}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  `);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `session-usage-${tag}` });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' },
    { projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'q', repoUrl: 'https://example.com/q.git' },
  ]);
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades projects, sessions, logs
  await db.execute(sql`delete from auth.users where id = ${OWNER}::uuid`);
});

describe('sessionUsageTree', () => {
  test('a session with no requests and no children costs 0', async () => {
    await session('lonely', null);
    const usage = await sessionUsageTree(await rowOf('lonely'), seeAllBut());
    expect(usage.currency).toBe('USD');
    expect(usage.sessions.map((s) => s.session_id)).toEqual([sid('lonely')]);
    expect(usage.total).toMatchObject({ cost: 0, request_count: 0 });
    expect(usage.hidden_sessions).toBe(0);
    expect(usage.truncated).toBe(false);
  });

  test('the total adds every descendant: wallet and own-key spend, depth-first, oldest child first', async () => {
    await session('root', null, { name: 'Coordinator' });
    await session('b', 'root', { at: 20, name: 'Second child' });
    await session('a', 'root', { at: 10, name: 'First child' });
    await session('a1', 'a', { at: 30 });
    await request('root', { kortix: 0.1, input: 100, output: 10 });
    await request('root', { kortix: 0.05, ok: false });
    await request('a', { kortix: 0.2, input: 50 });
    await request('a1', { provider: 0.3, output: 5 }); // own key: paid to the provider, not the wallet
    await request('b', { kortix: 0.4 });
    // Same session id, other project: not this session's request.
    await request('root', { kortix: 9, projectId: OTHER_PROJECT });

    const usage = await sessionUsageTree(await rowOf('root'), seeAllBut());

    expect(usage.sessions.map((s) => [s.session_id, s.depth, s.parent_session_id])).toEqual([
      [sid('root'), 0, null],
      [sid('a'), 1, sid('root')],
      [sid('a1'), 2, sid('a')],
      [sid('b'), 1, sid('root')],
    ]);
    expect(usage.sessions[0]).toMatchObject({ title: 'Coordinator', cost: 0.15, request_count: 2, error_count: 1, input_tokens: 100 });
    expect(usage.sessions[2]).toMatchObject({ cost: 0.3, kortix_cost: 0, provider_cost: 0.3 });
    expect(usage.total).toMatchObject({
      cost: 1.05, kortix_cost: 0.75, provider_cost: 0.3,
      request_count: 5, error_count: 1, input_tokens: 150, output_tokens: 15,
    });
  });

  test('a hidden child hides its subtree and its cost, and is counted', async () => {
    await session('h-root', null);
    await session('h-open', 'h-root', { at: 1 });
    await session('h-private', 'h-root', { at: 2 });
    await session('h-private-child', 'h-private', { at: 3 });
    await request('h-open', { kortix: 1 });
    await request('h-private', { kortix: 2 });
    await request('h-private-child', { kortix: 4 });

    const usage = await sessionUsageTree(await rowOf('h-root'), seeAllBut('h-private'));

    expect(usage.sessions.map((s) => s.session_id)).toEqual([sid('h-root'), sid('h-open')]);
    expect(usage.total.cost).toBe(1);
    expect(usage.hidden_sessions).toBe(2);
  });

  test('a deleted child and a child in another project are not read', async () => {
    await session('d-root', null);
    await session('d-gone', 'd-root', { deleted: true });
    await session('d-elsewhere', 'd-root', { projectId: OTHER_PROJECT });
    await request('d-gone', { kortix: 1 });

    const usage = await sessionUsageTree(await rowOf('d-root'), seeAllBut());

    expect(usage.sessions.map((s) => s.session_id)).toEqual([sid('d-root')]);
    expect(usage.hidden_sessions).toBe(0);
  });

  test('the walk stops one level past the depth limit and says so', async () => {
    await session('deep-0', null);
    for (let i = 1; i <= SESSION_USAGE_MAX_DEPTH + 2; i++) await session(`deep-${i}`, `deep-${i - 1}`, { at: i });

    const usage = await sessionUsageTree(await rowOf('deep-0'), seeAllBut());

    expect(usage.sessions).toHaveLength(SESSION_USAGE_MAX_DEPTH + 1);
    expect(usage.truncated).toBe(true);
  });

  test('a parent cycle through the session ends', async () => {
    await session('c-root', null);
    await session('c-1', 'c-root', { at: 1 });
    await session('c-2', 'c-1', { at: 2 });
    // c-root → c-1 → c-2 → c-root …
    await db.update(projectSessions).set({ parentSessionId: sid('c-2') }).where(eq(projectSessions.sessionId, sid('c-root')));

    const usage = await sessionUsageTree(await rowOf('c-root'), seeAllBut());

    expect(usage.sessions.map((s) => s.session_id)).toEqual([sid('c-root'), sid('c-1'), sid('c-2')]);
    expect(usage.sessions[0].parent_session_id).toBeNull();
  });
});
