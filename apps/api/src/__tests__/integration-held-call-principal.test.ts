/**
 * The caller of an approved held call, rebuilt from the held input without the
 * raw token (real Postgres). A live token gives the same principal as the
 * `/call` resolver, minus the sandbox lease. A dead token, a deleted session or
 * an offboarded member refuses. A re-minted session token of the same identity
 * runs. The agent grant is the smaller of the gate-time snapshot and the
 * current grant.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { type AgentGrant, accountMembers, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import type { HeldCallInput } from '../connectors/held-call-store';
import type { Writer } from '../iam/assignments';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

// The current grant normally comes from the project manifest (a git read).
// The suite sets it here; `undefined` keeps the token's stored grant.
let currentGrant: AgentGrant | null | undefined;
const realGrant = await import('../projects/lib/session-token-grant');
mock.module('../projects/lib/session-token-grant', () => ({
  ...realGrant,
  reconcileStoredSessionAgentGrant: async (input: { storedGrant?: AgentGrant | null }) =>
    currentGrant === undefined ? (input.storedGrant ?? null) : currentGrant,
}));

const { rebuildHeldCallPrincipal, resolveTokenPrincipal } = await import('../connectors/db-deps-principal');
const { createAccountToken, revokeAccountToken, revokeSessionConnectorTokens } = await import(
  '../repositories/account-tokens'
);
const { offboardMember } = await import('../accounts/core/offboard-member');
const { createServiceAccount, deleteServiceAccount, disableServiceAccount } = await import(
  '../repositories/service-accounts'
);
const { SYSTEM_ACTOR } = await import('../iam/assignments');

const GRANT: AgentGrant = {
  agent: 'mailer',
  permissions: 'all',
  connectors: ['billing'],
  policySets: { billing: 'strict' },
};
let seeded: SeededProject;
const userId: string = crypto.randomUUID();

interface Caller {
  sessionId: string;
  tokenId: string;
  secretKey: string;
}

async function caller(grant: AgentGrant | null = GRANT, user = userId): Promise<Caller> {
  const sessionId = await seedSession(seeded, user);
  const token = await createAccountToken({
    accountId: seeded.account_id,
    userId: user,
    projectId: seeded.project_id,
    sessionId,
    name: 'held-call-principal',
    agentGrant: grant,
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    status: 'active',
  });
  return { sessionId, tokenId: token.tokenId, secretKey: token.secretKey };
}

function heldFor(c: Caller, overrides: Partial<HeldCallInput> = {}, user = userId): HeldCallInput {
  return {
    v: 1,
    execution_id: crypto.randomUUID(),
    project_id: seeded.project_id,
    request_digest: 'digest',
    account_id: seeded.account_id,
    connector_slug: 'billing',
    action_path: 'charges.create',
    args: { amount: 1 },
    connection_id: 'conn-pinned',
    approval_context: null,
    policy_set: { name: 'strict', agent: 'mailer', manifestCommit: null },
    acting_token_id: c.tokenId,
    session_id: c.sessionId,
    user_id: user,
    agent_grant: GRANT,
    agent_principal: null,
    ...overrides,
  };
}

const stopSandbox = (sessionId: string) =>
  db.update(sessionSandboxes).set({ status: 'stopped' }).where(eq(sessionSandboxes.sessionId, sessionId));

beforeAll(async () => {
  seeded = await seedProject('held-call-principal');
  await insertIntoView(db, accountMembers, { accountId: seeded.account_id, userId, accountRole: 'owner' });
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${seeded.account_id}`);
  await db.execute(sql`delete from kortix.session_sandboxes where account_id = ${seeded.account_id}`);
  await db.execute(sql`delete from kortix.project_sessions where project_id = ${seeded.project_id}`);
  await db.execute(sql`delete from kortix.service_accounts where account_id = ${seeded.account_id}`);
  await removeSeeded([seeded]);
});

describe('rebuildHeldCallPrincipal', () => {
  test('a live token gives the /call principal, with the pinned connection and the policy set', async () => {
    currentGrant = undefined;
    const c = await caller();
    const fromRequest = await resolveTokenPrincipal(c.secretKey, null);
    const rebuilt = await rebuildHeldCallPrincipal(heldFor(c));
    expect(fromRequest).not.toBeNull();
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.principal).toEqual({ ...fromRequest!, requestedConnectorAccount: 'conn-pinned' });
    expect(rebuilt.principal.accountId).toBe(seeded.account_id);
    expect(rebuilt.principal.tokenId).toBe(c.tokenId);
    expect(rebuilt.policySet).toEqual({ name: 'strict', agent: 'mailer', manifestCommit: null });
  });

  test('a stopped sandbox runs: only the lease check is skipped', async () => {
    currentGrant = undefined;
    const c = await caller();
    await stopSandbox(c.sessionId);
    expect(await resolveTokenPrincipal(c.secretKey, null)).toBeNull();
    const rebuilt = await rebuildHeldCallPrincipal(heldFor(c));
    expect(rebuilt.ok).toBe(true);
  });

  test('a revoked token refuses caller_revoked', async () => {
    currentGrant = undefined;
    const c = await caller();
    await revokeAccountToken(c.tokenId, seeded.account_id);
    expect(await rebuildHeldCallPrincipal(heldFor(c))).toEqual({ ok: false, reason: 'caller_revoked' });
  });

  test('an expired token refuses caller_revoked', async () => {
    currentGrant = undefined;
    const c = await caller();
    await db.execute(
      sql`update kortix.account_tokens set expires_at = now() - interval '1 minute' where token_id = ${c.tokenId}`,
    );
    expect(await rebuildHeldCallPrincipal(heldFor(c))).toEqual({ ok: false, reason: 'caller_revoked' });
  });

  test('a call held without a token refuses caller_revoked', async () => {
    currentGrant = undefined;
    const c = await caller();
    expect(await rebuildHeldCallPrincipal(heldFor(c, { acting_token_id: null }))).toEqual({
      ok: false,
      reason: 'caller_revoked',
    });
  });

  test('a deleted session (tokens revoked, no re-mint) refuses caller_revoked', async () => {
    currentGrant = undefined;
    const c = await caller();
    await revokeSessionConnectorTokens(c.sessionId, seeded.account_id);
    expect(await rebuildHeldCallPrincipal(heldFor(c))).toEqual({ ok: false, reason: 'caller_revoked' });
  });

  test('a re-minted session token of the same identity runs as the new token', async () => {
    currentGrant = undefined;
    const c = await caller();
    await revokeSessionConnectorTokens(c.sessionId, seeded.account_id);
    const next = await createAccountToken({
      accountId: seeded.account_id,
      userId,
      projectId: seeded.project_id,
      sessionId: c.sessionId,
      name: 'held-call-principal-remint',
      agentGrant: GRANT,
    });
    const rebuilt = await rebuildHeldCallPrincipal(heldFor(c));
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) expect(rebuilt.principal.tokenId).toBe(next.tokenId);
  });

  test('a token of another user in the same session is not a re-mint', async () => {
    currentGrant = undefined;
    const other = crypto.randomUUID();
    await insertIntoView(db, accountMembers, { accountId: seeded.account_id, userId: other, accountRole: 'member' });
    const c = await caller();
    await revokeSessionConnectorTokens(c.sessionId, seeded.account_id);
    await createAccountToken({
      accountId: seeded.account_id,
      userId: other,
      projectId: seeded.project_id,
      sessionId: c.sessionId,
      name: 'held-call-principal-other',
      agentGrant: GRANT,
    });
    expect(await rebuildHeldCallPrincipal(heldFor(c))).toEqual({ ok: false, reason: 'caller_revoked' });
  });

  test('an offboarded member refuses caller_revoked', async () => {
    currentGrant = undefined;
    const member = crypto.randomUUID();
    await insertIntoView(db, accountMembers, { accountId: seeded.account_id, userId: member, accountRole: 'member' });
    const c = await caller(GRANT, member);
    expect((await rebuildHeldCallPrincipal(heldFor(c, {}, member))).ok).toBe(true);
    await offboardMember(SYSTEM_ACTOR as Writer, seeded.account_id, member, 'left');
    expect(await rebuildHeldCallPrincipal(heldFor(c, {}, member))).toEqual({ ok: false, reason: 'caller_revoked' });
  });

  test('a service-account caller (a trigger session re-minted from created_by) runs while the account is active', async () => {
    currentGrant = undefined;
    const sa = await createServiceAccount({ accountId: seeded.account_id, name: 'held-call-sa-disable', createdBy: userId });
    const c = await caller(GRANT, sa.serviceAccountId);
    const rebuilt = await rebuildHeldCallPrincipal(heldFor(c, {}, sa.serviceAccountId));
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) expect(rebuilt.principal.userId).toBe(sa.serviceAccountId);
    await disableServiceAccount({ accountId: seeded.account_id, serviceAccountId: sa.serviceAccountId, disabledBy: userId });
    expect(await rebuildHeldCallPrincipal(heldFor(c, {}, sa.serviceAccountId))).toEqual({
      ok: false,
      reason: 'caller_revoked',
    });
  });

  test('a deleted service-account caller refuses caller_revoked', async () => {
    currentGrant = undefined;
    const sa = await createServiceAccount({ accountId: seeded.account_id, name: 'held-call-sa-delete', createdBy: userId });
    const c = await caller(GRANT, sa.serviceAccountId);
    expect((await rebuildHeldCallPrincipal(heldFor(c, {}, sa.serviceAccountId))).ok).toBe(true);
    await deleteServiceAccount(seeded.account_id, sa.serviceAccountId);
    expect(await rebuildHeldCallPrincipal(heldFor(c, {}, sa.serviceAccountId))).toEqual({
      ok: false,
      reason: 'caller_revoked',
    });
  });

  test('a grant that no longer allows the connector refuses grant_narrowed', async () => {
    currentGrant = { ...GRANT, connectors: ['crm'] };
    const c = await caller();
    expect(await rebuildHeldCallPrincipal(heldFor(c))).toEqual({ ok: false, reason: 'grant_narrowed' });
  });

  test('a grown grant does not widen: the snapshot still limits it', async () => {
    currentGrant = { ...GRANT, connectors: 'all' };
    const c = await caller();
    const snapshot: AgentGrant = { ...GRANT, connectors: ['crm'] };
    expect(await rebuildHeldCallPrincipal(heldFor(c, { agent_grant: snapshot }))).toEqual({
      ok: false,
      reason: 'grant_narrowed',
    });
  });

  test('an agent principal at gate time that is gone now refuses principal_mode_changed', async () => {
    currentGrant = undefined;
    const c = await caller();
    const held = heldFor(c, { agent_principal: { onBehalfOfUserId: userId, agentId: crypto.randomUUID() } });
    expect(await rebuildHeldCallPrincipal(held)).toEqual({ ok: false, reason: 'principal_mode_changed' });
  });

  test('a held input that names another session refuses caller_mismatch', async () => {
    currentGrant = undefined;
    const c = await caller();
    expect(await rebuildHeldCallPrincipal(heldFor(c, { session_id: crypto.randomUUID() }))).toEqual({
      ok: false,
      reason: 'caller_mismatch',
    });
  });
});
