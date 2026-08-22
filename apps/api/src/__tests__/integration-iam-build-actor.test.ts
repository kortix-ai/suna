/**
 * `buildActor` against a REAL Hono context and a REAL account_tokens row.
 *
 * This is the seam that replaces "the route remembered to thread
 * `c.get('iamTokenId')`". It has to classify all five auth branches correctly
 * from the context keys `middleware/auth.ts` sets, because everything
 * downstream — token confinement, the agent-grant fold, standing identity — is
 * derived from the credential it produces, not from an argument a caller may
 * forget.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, hasDatabase } from '../shared/db';
import { buildActor, type Actor } from '../iam/actor';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const SA = crypto.randomUUID();
const PAT_TOKEN = crypto.randomUUID();
const AGENT_TOKEN = crypto.randomUUID();

const GRANT = { agent: 'builder', kortixCli: ['project.gitops.push'], connectors: 'all' as const };

async function raw(text: string): Promise<void> {
  await db.execute(sql.raw(text));
}

/** Mount a handler behind a middleware that sets exactly the keys the matching
 *  branch of `middleware/auth.ts` sets, then return the Actor it produced. */
async function actorFromContext(keys: Record<string, unknown>): Promise<Actor | null> {
  const app = new Hono();
  let captured: Actor | null = null;
  app.get('/probe', async (c) => {
    for (const [k, v] of Object.entries(keys)) c.set(k as never, v as never);
    captured = await buildActor(c);
    return c.json({ ok: true });
  });
  await app.request('http://local.test/probe', {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
  });
  return captured;
}

beforeAll(async () => {
  if (!hasDatabase) return;
  await raw(`insert into kortix.accounts (account_id, name) values ('${ACCOUNT}','build-actor')`);
  await raw(
    `insert into kortix.projects (project_id, account_id, name, repo_url)
     values ('${PROJECT}','${ACCOUNT}','p','https://example.invalid/p.git')`,
  );
  await raw(
    `insert into kortix.service_accounts (service_account_id, account_id, name, secret_hash, public_prefix, project_id)
     values ('${SA}','${ACCOUNT}','agent-sa','h-${SA}','kortix_sa_ba','${PROJECT}')`,
  );
  await raw(
    `insert into kortix.account_tokens (token_id, account_id, user_id, name, public_key, secret_key_hash, project_id)
     values ('${PAT_TOKEN}','${ACCOUNT}','${USER}','pat','pk-${PAT_TOKEN}','sk-${PAT_TOKEN}','${PROJECT}')`,
  );
  await raw(
    `insert into kortix.account_tokens
       (token_id, account_id, user_id, name, public_key, secret_key_hash, project_id, session_id, agent_grant, service_account_id)
     values ('${AGENT_TOKEN}','${ACCOUNT}','${USER}','agent','pk-${AGENT_TOKEN}','sk-${AGENT_TOKEN}',
             '${PROJECT}','sess-1','${JSON.stringify(GRANT)}'::jsonb,'${SA}')`,
  );
});

afterAll(async () => {
  if (!hasDatabase) return;
  await raw(`delete from kortix.accounts where account_id = '${ACCOUNT}'`);
});

describe.if(hasDatabase)('buildActor', () => {
  test('a Supabase JWT becomes a jwt credential and carries the MFA level', async () => {
    const actor = await actorFromContext({
      userId: USER,
      accountId: ACCOUNT,
      authType: 'supabase',
      mfaAal: 'aal2',
    });
    expect(actor?.credential).toEqual({ kind: 'jwt' });
    expect(actor?.ctx.mfaAal).toBe('aal2');
    // First hop only — a spoofed second hop must never become the caller's IP.
    expect(actor?.ctx.ip).toBe('203.0.113.9');
  });

  test('a project-bound PAT carries its confinement', async () => {
    const actor = await actorFromContext({
      userId: USER,
      accountId: ACCOUNT,
      authType: 'pat',
      iamTokenId: PAT_TOKEN,
      tokenProjectId: PROJECT,
    });
    expect(actor?.credential).toEqual({ kind: 'pat', tokenId: PAT_TOKEN, projectId: PROJECT });
  });

  test('a session token naming a service account becomes an agent_session', async () => {
    const actor = await actorFromContext({
      userId: USER,
      accountId: ACCOUNT,
      authType: 'pat',
      iamTokenId: AGENT_TOKEN,
      sessionId: 'sess-1',
      agentGrant: GRANT,
    });
    expect(actor?.credential.kind).toBe('agent_session');
    if (actor?.credential.kind !== 'agent_session') throw new Error('unreachable');
    expect(actor.credential.serviceAccountId).toBe(SA);
    expect(actor.credential.projectId).toBe(PROJECT);
    expect(actor.credential.agentGrant).toEqual(GRANT);
    // No role has been assigned to the service account, so the session is NOT
    // activated and authorizes as its launcher. This is the opt-in.
    expect(actor.credential.activated).toBe(false);
  });

  test('assigning the service account a role flips activation', async () => {
    const roleId = crypto.randomUUID();
    await raw(
      `insert into kortix.iam_roles (role_id, account_id, key, name, scope_type)
       values ('${roleId}','${ACCOUNT}','ba_role','BA','project')`,
    );
    await raw(
      `insert into kortix.role_assignments (account_id, principal_type, principal_id, role_id, scope_type, scope_id)
       values ('${ACCOUNT}','service_account','${SA}','${roleId}','project','${PROJECT}')`,
    );
    const actor = await actorFromContext({
      userId: USER,
      accountId: ACCOUNT,
      authType: 'pat',
      iamTokenId: AGENT_TOKEN,
      agentGrant: GRANT,
    });
    if (actor?.credential.kind !== 'agent_session') throw new Error('unreachable');
    expect(actor.credential.activated).toBe(true);
  });

  test('a direct service-account bearer is its own principal', async () => {
    const actor = await actorFromContext({
      userId: SA,
      accountId: ACCOUNT,
      authType: 'service_account',
      iamTokenId: SA,
    });
    expect(actor?.credential).toEqual({ kind: 'service_account', serviceAccountId: SA });
  });

  test('a sandbox token is a credential with no IAM identity behind it', async () => {
    // auth.ts maps `userId` to the ACCOUNT id on this branch, which is why it
    // must be classified explicitly rather than falling through to `jwt`.
    const actor = await actorFromContext({
      userId: ACCOUNT,
      accountId: ACCOUNT,
      authType: 'apiKey',
      apiKeyType: 'sandbox',
      sandboxId: 'sb-1',
    });
    expect(actor?.credential).toEqual({ kind: 'sandbox' });
  });

  test('no identity at all produces no actor', async () => {
    expect(await actorFromContext({ accountId: ACCOUNT })).toBeNull();
  });
});
