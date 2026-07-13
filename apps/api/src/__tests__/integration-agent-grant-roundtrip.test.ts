/**
 * Integration test (real local DB): the per-agent grant round-trips through the
 * account token, and the enforcement helpers gate correctly off the validated
 * grant. Proves the full stack below the HTTP layer — schema column → insert →
 * select → repo serialization → enforcement.
 *
 * Runs against the local Postgres (DATABASE_URL). Applies the additive
 * `agent_grant` column idempotently in beforeAll (mirrors ensureSchema's push).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { createAccountToken, validateAccountToken } from '../repositories/account-tokens';
import { agentMayPerform, agentMayUseConnector } from '../iam/agent-scope';

let tokenId: string | null = null;

beforeAll(async () => {
  // Idempotently ensure the columns createAccountToken writes (local DB may be
  // behind on migrations).
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
});

afterAll(async () => {
  if (tokenId) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
});

describe('agent_grant — real DB round-trip + enforcement', () => {
  test('mint with grant → validate returns it → gates allow/deny correctly', async () => {
    const rows = (await db.execute(
      sql`select project_id, account_id from kortix.projects limit 1`,
    )) as unknown as Array<{ project_id: string; account_id: string }>;
    const proj = rows[0];
    if (!proj) {
      console.warn('[integration] no project in local DB — skipping round-trip');
      return;
    }

    const grant = { agent: 'release-bot', kortixCli: ['project.cr.open'], connectors: ['github'] };

    const minted = await createAccountToken({
      accountId: proj.account_id,
      userId: crypto.randomUUID(),
      projectId: proj.project_id,
      name: 'test-agent-grant-roundtrip',
      agentGrant: grant as any,
    });
    tokenId = minted.tokenId;

    // The grant survives the DB round-trip exactly.
    const v = await validateAccountToken(minted.secretKey);
    expect(v.isValid).toBe(true);
    expect(v.agentGrant).toEqual(grant);

    // Enforcement reads the validated grant and gates correctly.
    expect(agentMayPerform(v.agentGrant!, 'project.cr.open')).toBe(true);   // granted
    expect(agentMayPerform(v.agentGrant!, 'project.cr.merge')).toBe(false); // NOT granted — the destructive case
    expect(agentMayPerform(v.agentGrant!, 'project.trigger.create')).toBe(false);
    expect(agentMayUseConnector(v.agentGrant!, 'github')).toBe(true);       // assigned
    expect(agentMayUseConnector(v.agentGrant!, 'salesforce')).toBe(false);  // not assigned
  });

  test('a token minted WITHOUT a grant returns null (full access — backward compatible)', async () => {
    const rows = (await db.execute(
      sql`select project_id, account_id from kortix.projects limit 1`,
    )) as unknown as Array<{ project_id: string; account_id: string }>;
    const proj = rows[0];
    if (!proj) return;
    const minted = await createAccountToken({
      accountId: proj.account_id,
      userId: crypto.randomUUID(),
      projectId: proj.project_id,
      name: 'test-no-grant',
    });
    const v = await validateAccountToken(minted.secretKey);
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${minted.tokenId}`);
    expect(v.agentGrant ?? null).toBeNull();
    expect(agentMayPerform(v.agentGrant ?? null, 'project.cr.merge')).toBe(true); // no grant = no restriction
  });
});
