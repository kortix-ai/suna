/**
 * Integration test (real local DB): sessionModelUsage — which model answered a
 * session's requests, and what Kortix billed for them, read from the gateway's
 * request ledger and attributed to turns.
 *
 * Incident 2026-10-02: a project's chain answered every request of a session
 * from a Kortix model while the session screen named the selected ChatGPT
 * model and priced each turn at $0.
 *
 * Every row is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projectSessions, projects, sessionTurns } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { projectSpendByModel, sessionModelUsage } from '../projects/lib/session-model-usage';
import { db } from '../shared/db';

const tag = crypto.randomUUID().slice(0, 8);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const SPEND_PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SANDBOX = crypto.randomUUID();
const sid = (id: string) => `${id}-${tag}`;
// One hour ago, so every row sits inside a spend window.
const T0 = Math.floor(Date.now() / 1000) * 1000 - 60 * 60 * 1000;
const at = (seconds: number) => new Date(T0 + seconds * 1000);

async function session(id: string, projectId = PROJECT) {
  await db.insert(projectSessions).values({
    sessionId: sid(id), accountId: ACCOUNT, projectId, branchName: sid(id), createdBy: OWNER,
  });
}

async function turn(sessionId: string, messageId: string, startedAt: number, endedAt: number | null) {
  await db.insert(sessionTurns).values({
    turnToken: crypto.randomUUID(), sessionId: sid(sessionId), sandboxId: SANDBOX, projectId: PROJECT, accountId: ACCOUNT,
    messageId, state: endedAt === null ? 'active' : 'ended', endReason: endedAt === null ? null : 'completed',
    startedAt: at(startedAt), endedAt: endedAt === null ? null : at(endedAt),
  });
}

async function request(input: {
  session: string;
  at: number;
  requested: string;
  resolved: string;
  provider: string;
  cost?: number;
  ok?: boolean;
  projectId?: string;
  metadata?: Record<string, unknown>;
}) {
  const billed = input.cost ?? 0;
  await db.insert(gatewayRequestLogs).values({
    requestId: `req-${crypto.randomUUID()}`, accountId: ACCOUNT, projectId: input.projectId ?? PROJECT,
    sessionId: sid(input.session), requestedModel: input.requested, resolvedModel: input.resolved,
    provider: input.provider, status: input.ok === false ? 429 : 200, ok: input.ok !== false,
    finalCost: String(billed), billingMode: billed > 0 ? 'credits' : 'none',
    metadata: input.metadata ?? {}, createdAt: at(input.at),
  });
}

const usageOf = (id: string, projectId = PROJECT) => sessionModelUsage({ sessionId: sid(id), projectId });

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role) values
      (${OWNER}::uuid, ${`owner-${tag}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  `);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `model-usage-${tag}` });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' },
    { projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'q', repoUrl: 'https://example.com/q.git' },
    { projectId: SPEND_PROJECT, accountId: ACCOUNT, name: 's', repoUrl: 'https://example.com/s.git' },
  ]);
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades projects, sessions, logs
  await db.delete(sessionTurns).where(eq(sessionTurns.accountId, ACCOUNT));
  await db.execute(sql`delete from auth.users where id = ${OWNER}::uuid`);
});

describe('sessionModelUsage', () => {
  test('a session with no gateway request has no latest model, no cost and no turns', async () => {
    await session('empty');
    expect(await usageOf('empty')).toEqual({ latest: null, billed_cost: 0, turns: {} });
  });

  test('a turn its own model answered names that model and no fallback', async () => {
    await session('direct');
    await turn('direct', 'msg_direct_1', 0, 30);
    await request({
      session: 'direct', at: 10, requested: 'codex/gpt-6.1-sol', resolved: 'gpt-6.1-sol', provider: 'openai-codex',
      metadata: { servedModel: 'codex/gpt-6.1-sol' },
    });

    expect(await usageOf('direct')).toEqual({
      latest: { served_model: 'codex/gpt-6.1-sol', fallback_from: null, at: at(10).toISOString() },
      billed_cost: 0,
      turns: { msg_direct_1: { served_models: ['codex/gpt-6.1-sol'], fallback_from: null, billed_cost: 0 } },
    });
  });

  test('a fallback answer names the model that answered, the model it replaced, and the billed cost per turn', async () => {
    await session('chain');
    await turn('chain', 'msg_chain_1', 0, 30);
    await turn('chain', 'msg_chain_2', 100, null);
    const fallback = { servedModel: 'glm-5.3-flash', fallbackFrom: 'codex/gpt-6.1-sol' };
    // Turn 1: its own model, then the chain. A trace is written when the
    // request ends, so the last row of turn 1 lands after the turn's end.
    await request({ session: 'chain', at: 5, requested: 'codex/gpt-6.1-sol', resolved: 'gpt-6.1-sol', provider: 'openai-codex', metadata: { servedModel: 'codex/gpt-6.1-sol' } });
    await request({ session: 'chain', at: 20, requested: 'codex/gpt-6.1-sol', resolved: 'glm-5.3-flash', provider: 'kortix', cost: 0.25, metadata: fallback });
    await request({ session: 'chain', at: 31, requested: 'codex/gpt-6.1-sol', resolved: 'glm-5.3-flash', provider: 'kortix', cost: 0.5, metadata: fallback });
    // Turn 2, still running: one failed request (no answer, no model) and one answer.
    await request({ session: 'chain', at: 110, requested: 'codex/gpt-6.1-sol', resolved: 'gpt-6.1-sol', provider: 'openai-codex', ok: false });
    await request({ session: 'chain', at: 120, requested: 'codex/gpt-6.1-sol', resolved: 'deepseek-v4.1-flash', provider: 'kortix', cost: 0.125, metadata: { servedModel: 'deepseek-v4.1-flash', fallbackFrom: 'codex/gpt-6.1-sol' } });
    // Another session and another project never leak in.
    await session('other');
    await request({ session: 'other', at: 130, requested: 'kimi-k3', resolved: 'kimi-k3', provider: 'kortix', cost: 9, metadata: { servedModel: 'kimi-k3' } });
    await request({ session: 'chain', at: 140, requested: 'kimi-k3', resolved: 'kimi-k3', provider: 'kortix', cost: 7, projectId: OTHER_PROJECT, metadata: { servedModel: 'kimi-k3' } });

    expect(await usageOf('chain')).toEqual({
      latest: { served_model: 'deepseek-v4.1-flash', fallback_from: 'codex/gpt-6.1-sol', at: at(120).toISOString() },
      billed_cost: 0.875,
      turns: {
        // Most requests first.
        msg_chain_1: { served_models: ['glm-5.3-flash', 'codex/gpt-6.1-sol'], fallback_from: 'codex/gpt-6.1-sol', billed_cost: 0.75 },
        msg_chain_2: { served_models: ['deepseek-v4.1-flash'], fallback_from: 'codex/gpt-6.1-sol', billed_cost: 0.125 },
      },
    });
  });

  test('a request logged before the serving model was recorded is read from its own columns', async () => {
    await session('legacy');
    await turn('legacy', 'msg_legacy_1', 0, 30);
    // A Kortix model answered a request for another model after a failed attempt: a fallback.
    await request({
      session: 'legacy', at: 10, requested: 'codex/gpt-6.1-sol', resolved: 'glm-5.3-flash', provider: 'kortix', cost: 0.5,
      metadata: { attemptFailures: [{ attempt: 1, provider: 'openai-codex', routeModel: 'codex/gpt-6.1-sol', status: 429 }] },
    });
    // An own-key answer keeps the id the client asked for; the upstream id is not a route id.
    await request({ session: 'legacy', at: 12, requested: 'openai/gpt-5.4', resolved: 'gpt-5.4', provider: 'openai' });
    // `auto` resolved to a Kortix model with no failed attempt: not a fallback.
    await request({ session: 'legacy', at: 14, requested: 'auto', resolved: 'deepseek-v4.1-flash', provider: 'kortix', cost: 0.25 });

    const usage = await usageOf('legacy');
    expect(usage.latest).toEqual({ served_model: 'deepseek-v4.1-flash', fallback_from: null, at: at(14).toISOString() });
    expect(usage.billed_cost).toBe(0.75);
    expect(usage.turns.msg_legacy_1).toEqual({
      served_models: expect.arrayContaining(['glm-5.3-flash', 'openai/gpt-5.4', 'deepseek-v4.1-flash']),
      fallback_from: 'codex/gpt-6.1-sol',
      billed_cost: 0.75,
    });
    expect(usage.turns.msg_legacy_1?.served_models).toHaveLength(3);
  });
});

describe('projectSpendByModel', () => {
  test('a fallback answer is spend of the model that answered, not of the model that was asked for', async () => {
    await session('spend', SPEND_PROJECT);
    const fallback = { servedModel: 'glm-5.3-flash', fallbackFrom: 'codex/gpt-6.1-sol' };
    const row = { session: 'spend', projectId: SPEND_PROJECT, requested: 'codex/gpt-6.1-sol' };
    await request({ ...row, at: 10, resolved: 'glm-5.3-flash', provider: 'kortix', cost: 0.25, metadata: fallback });
    await request({ ...row, at: 20, resolved: 'glm-5.3-flash', provider: 'kortix', cost: 0.5, metadata: fallback });
    await request({ ...row, at: 30, resolved: 'gpt-6.1-sol', provider: 'openai-codex', metadata: { servedModel: 'codex/gpt-6.1-sol' } });

    expect(await projectSpendByModel(SPEND_PROJECT, 30)).toEqual([
      { model: 'glm-5.3-flash', provider: 'kortix', requests: 2, errors: 0, cost: 0.75, kortix_cost: 0.75, provider_cost: 0, tokens: 0 },
      { model: 'codex/gpt-6.1-sol', provider: 'openai-codex', requests: 1, errors: 0, cost: 0, kortix_cost: 0, provider_cost: 0, tokens: 0 },
    ]);
  });
});
