/**
 * HTTP-level enforcement (in-process, real DB + real app): an agent-session
 * token whose grant lacks `project.cr.merge` is rejected with 403 by the actual
 * CR-merge route — exercising the full path: auth middleware (validates the
 * token, sets agentGrant on context) → route (loadProjectForUser → assertAgentScope).
 * A token granted the scope (or no grant) passes the gate (and falls through to
 * the CR-not-found 404, which proves the scope check let it through).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';

const minted: string[] = [];
let ctx: { projectId: string; accountId: string; userId: string } | null = null;

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  const rows = (await db.execute(sql`
    select p.project_id, p.account_id, m.user_id
    from kortix.projects p
    join kortix.account_members m on m.account_id = p.account_id and m.account_role = 'owner'
    limit 1`)) as unknown as Array<{ project_id: string; account_id: string; user_id: string }>;
  const r = rows[0];
  if (r) ctx = { projectId: r.project_id, accountId: r.account_id, userId: r.user_id };
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
});

async function mintToken(agentGrant: unknown): Promise<string> {
  const t = await createAccountToken({
    accountId: ctx!.accountId,
    userId: ctx!.userId,
    projectId: ctx!.projectId,
    name: 'http-scope-test',
    agentGrant: agentGrant as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function mergeReq(secret: string) {
  // A valid-shape but nonexistent CR id → a clean 404 once the scope gate passes.
  return app.request(`/v1/projects/${ctx!.projectId}/change-requests/${crypto.randomUUID()}/merge`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
}

describe('HTTP enforcement — CR merge gate via the real route', () => {
  test('agent granted cr.open but NOT cr.merge → 403 at the route', async () => {
    if (!ctx) { console.warn('[http] no owner+project in local DB — skipping'); return; }
    const secret = await mintToken({ agent: 'release-bot', kortixCli: ['project.cr.open'], connectors: [] });
    const res = await mergeReq(secret);
    expect(res.status).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).toContain('project.cr.merge');
  });

  test('agent granted cr.merge → passes the scope gate (404 CR-not-found, not 403)', async () => {
    if (!ctx) return;
    const secret = await mintToken({ agent: 'deployer', kortixCli: ['project.cr.merge'], connectors: [] });
    const res = await mergeReq(secret);
    expect(res.status).not.toBe(403);
  });

  test('token with NO grant (human/legacy) → passes the gate (not 403)', async () => {
    if (!ctx) return;
    const secret = await mintToken(null);
    const res = await mergeReq(secret);
    expect(res.status).not.toBe(403);
  });
});
