/**
 * The held call input (real Postgres, in-process app). A new approval gate
 * created through the gateway writes one `connector_held_calls` row in state
 * `held` whose `input_enc` decrypts to the call input and the caller. The
 * plaintext carries the gate's ids and digest, so a ciphertext copied to
 * another gate is refused. A wipe sets `input_enc` to NULL. A failed held write
 * keeps the gate. Only a project-scoped token holds: a dashboard JWT or an
 * unscoped PAT keeps the carry-over. No approvals or review read returns the
 * held input.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, connectorCalls, connectorConnections, connectorHeldCalls, connectors } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import type { GatewayAction, GatewayConnector, GatewayDeps } from '../connectors/gateway';
import { HeldInputRefusedError, readHeldInput, wipeHeldInput } from '../connectors/held-call-store';
import { connectorRequestDigest } from '../connectors/request-digest';
import type { ConnectorPrincipal } from '../connectors/router-contract';
import type { ApprovalCaller } from '../projects/lib/approval-authority';
import { getInboxItem, listInboxItems } from '../projects/review-items';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { createAccountToken } from '../repositories/account-tokens';

const HUMAN_SESSION = 'held-call-store-human-session';
const humanUserId = crypto.randomUUID();
mock.module('../shared/jwt-verify', () => ({
  verifySupabaseJwt: async (token: string) =>
    token === HUMAN_SESSION
      ? { ok: true, userId: humanUserId, email: 'held-call-store@example.test', payload: {} }
      : { ok: false, reason: 'invalid-signature' as const },
  decodeSupabaseJwtPayload: () => null,
}));

const { app } = await import('../index');
const { makeDbGatewayDeps } = await import('../connectors/db-deps-gateway');
const { handleCall } = await import('../connectors/gateway');

/** Credential-shaped, so the redacted preview never shows it. */
const SENTINEL = 'held-call-sentinel-7f3a9c';
const connectorId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
let sessionId = '';
let tokenId = '';
let seeded: SeededProject;
let principal: ConnectorPrincipal;
let deps: GatewayDeps;

const CONNECTOR = (): GatewayConnector => ({
  connectorId,
  connectionId,
  slug: 'billing',
  provider: 'openapi',
  baseUrl: 'https://billing.example.test',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
});
const ACTION: GatewayAction = {
  path: 'billing.charges.create',
  relPath: 'charges.create',
  inputSchema: null,
  risk: 'write',
  binding: { kind: 'openapi', method: 'POST', path: '/v1/charges', server: 'https://billing.example.test' },
};
const asOwner = async (): Promise<ApprovalCaller> => ({
  isManager: true,
  callerUserId: humanUserId,
  callerAuthType: 'supabase',
  callerCredentialKind: 'jwt',
  callerSessionId: null,
});
const FULL_VIEW = { where: () => undefined, allows: async () => true };
const authed = (path: string) => app.request(path, { headers: { Authorization: `Bearer ${HUMAN_SESSION}` } });

async function gate(args: Record<string, unknown>, gateDeps: GatewayDeps = deps, actingTokenId: string | null = tokenId): Promise<string> {
  const result = await handleCall(gateDeps, {
    projectId: seeded.project_id,
    accountId: seeded.account_id,
    subject: { userId: humanUserId, groupIds: [] },
    sessionId,
    actingTokenId,
    connectorSlug: 'billing',
    actionPath: 'charges.create',
    args,
    approvalContext: 'Charges the test customer',
  });
  if (result.status !== 'pending_approval' || !result.executionId) throw new Error(`not held: ${result.status}`);
  return result.executionId;
}
/** The suite's connector, action, credential and policy overrides, without the principal-bound writer. */
const pick = (d: GatewayDeps): Partial<GatewayDeps> => ({
  loadConnectorBySlug: d.loadConnectorBySlug,
  loadAction: d.loadAction,
  resolveCredential: d.resolveCredential,
  loadPolicies: d.loadPolicies,
  loadProjectPolicies: d.loadProjectPolicies,
  loadDefaultMode: d.loadDefaultMode,
  mintApprovalLink: undefined,
  postApprovalCard: undefined,
  approvalEnrichers: {},
});
const heldRows = (executionId: string) =>
  db.select().from(connectorHeldCalls).where(eq(connectorHeldCalls.executionId, executionId));

beforeAll(async () => {
  seeded = await seedProject('held-call-store');
  await insertIntoView(db, accountMembers, { accountId: seeded.account_id, userId: humanUserId, accountRole: 'owner' });
  await db.insert(connectors).values({
    connectorId,
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    slug: 'billing',
    name: 'Billing',
    providerType: 'openapi',
    config: { baseUrl: 'https://billing.example.test', auth: { type: 'bearer' } },
  });
  await db.insert(connectorConnections).values({
    connectionId,
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    connectorId,
    label: 'Default',
    isDefault: true,
  });
  sessionId = await seedSession(seeded, humanUserId);
  tokenId = (
    await createAccountToken({
      accountId: seeded.account_id,
      userId: humanUserId,
      projectId: seeded.project_id,
      sessionId,
      name: 'held-call-store',
    })
  ).tokenId;
  principal = {
    userId: humanUserId,
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    sessionId,
    tokenId,
    subject: { userId: humanUserId, groupIds: [] },
    agentGrant: null,
    agentPrincipal: null,
  };
  deps = {
    ...makeDbGatewayDeps(principal),
    loadConnectorBySlug: async () => CONNECTOR(),
    loadAction: async () => ACTION,
    resolveCredential: async () => 'test-credential',
    loadPolicies: async () => [{ match: '*', action: 'require_approval' }],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    mintApprovalLink: undefined,
    postApprovalCard: undefined,
    approvalEnrichers: {},
  };
}, 30_000);

afterAll(async () => {
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, seeded.project_id));
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, seeded.project_id));
  await db.delete(connectors).where(eq(connectors.projectId, seeded.project_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${seeded.account_id}`);
  await db.execute(sql`delete from kortix.project_sessions where project_id = ${seeded.project_id}`);
  await deleteFromView(
    db,
    accountMembers,
    sql`${accountMembers.accountId} = ${seeded.account_id} and ${accountMembers.userId} = ${humanUserId}`,
  );
  await removeSeeded([seeded]);
}, 30_000);

describe('held call input', () => {
  test('a new gate writes one held row whose input decrypts to the call and the caller', async () => {
    const args = { amount: 500, api_key: SENTINEL };
    const executionId = await gate(args);
    const rows = await heldRows(executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: seeded.project_id, accountId: seeded.account_id, state: 'held' });
    expect(rows[0].inputEnc).toStartWith('v1:');
    expect(rows[0].inputEnc).not.toContain(SENTINEL);

    const [call] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, executionId));
    expect(await readHeldInput(executionId)).toEqual({
      v: 1,
      execution_id: executionId,
      project_id: seeded.project_id,
      request_digest: call.requestDigest!,
      account_id: seeded.account_id,
      connector_slug: 'billing',
      action_path: 'charges.create',
      args,
      connection_id: connectionId,
      approval_context: 'Charges the test customer',
      policy_set: null,
      acting_token_id: tokenId,
      session_id: sessionId,
      user_id: humanUserId,
      agent_grant: null,
      agent_principal: null,
    });
  });

  test('a ciphertext copied to another gate is refused; a damaged one is undecryptable', async () => {
    const a = await gate({ amount: 1 });
    const b = await gate({ amount: 2 });
    const [rowA] = await heldRows(a);
    await db
      .update(connectorHeldCalls)
      .set({ inputEnc: rowA.inputEnc, updatedAt: new Date() })
      .where(eq(connectorHeldCalls.executionId, b));
    const copied = await readHeldInput(b).catch((error: unknown) => error);
    expect(copied).toBeInstanceOf(HeldInputRefusedError);
    expect((copied as HeldInputRefusedError).reason).toBe('held_input_mismatch');

    const [iv, tag, ct] = rowA.inputEnc!.split(':').slice(1);
    const flipped = `v1:${iv}:${tag}:${ct.startsWith('A') ? 'B' : 'A'}${ct.slice(1)}`;
    await db.update(connectorHeldCalls).set({ inputEnc: flipped }).where(eq(connectorHeldCalls.executionId, b));
    const damaged = await readHeldInput(b).catch((error: unknown) => error);
    expect((damaged as HeldInputRefusedError).reason).toBe('held_input_undecryptable');
  });

  test('an email gate holds the caller args without the injected inbox, thread or message ids', async () => {
    const email: GatewayConnector = {
      ...CONNECTOR(),
      slug: 'email',
      provider: 'channel',
      platform: 'email',
      baseUrl: null,
      connectionMetadata: { inbox_id: 'inbox-synthetic' },
    };
    const reply: GatewayAction = {
      path: 'email.reply_message',
      relPath: 'reply_message',
      inputSchema: null,
      risk: 'write',
      binding: { kind: 'http', method: 'POST', path: 'inboxes/{inbox_id}/threads/{thread_id}/emails/{message_id}/reply' },
    };
    const emailDeps: GatewayDeps = {
      ...deps,
      loadConnectorBySlug: async () => email,
      loadAction: async () => reply,
      loadEmailSessionContext: async () => ({ threadId: 'thread-synthetic', messageId: 'message-synthetic' }),
      resolveEmailCredentialForInbox: async () => 'resend_test_key',
      gateChannelRead: undefined,
      gateChannelWrite: undefined,
    };
    const callerArgs = { text: 'Thanks, confirmed.' };
    const result = await handleCall(emailDeps, {
      projectId: seeded.project_id,
      accountId: seeded.account_id,
      subject: { userId: humanUserId, groupIds: [] },
      sessionId,
      actingTokenId: tokenId,
      connectorSlug: 'email',
      actionPath: 'reply_message',
      args: callerArgs,
    });
    if (result.status !== 'pending_approval' || !result.executionId) throw new Error(`not held: ${result.status}`);
    const held = await readHeldInput(result.executionId);
    expect(held?.args).toEqual(callerArgs);
    // The digest still binds the injected execution args.
    const [call] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, result.executionId));
    const injected = {
      ...callerArgs,
      inbox_id: 'inbox-synthetic',
      thread_id: 'thread-synthetic',
      message_id: 'message-synthetic',
    };
    const context = { connectionId, provider: 'channel', baseUrl: null, binding: reply.binding };
    expect(call.requestDigest).toBe(connectorRequestDigest('email', 'reply_message', injected, context));
    expect(held?.request_digest).toBe(call.requestDigest!);
  });

  test('a caller without a project-scoped token gets the gate but no held row', async () => {
    const pat = await createAccountToken({ accountId: seeded.account_id, userId: humanUserId, name: 'held-call-store-pat' });
    for (const actingTokenId of [null, pat.tokenId]) {
      const executionId = await gate({ amount: 7 }, { ...makeDbGatewayDeps({ ...principal, tokenId: actingTokenId }), ...pick(deps) }, actingTokenId);
      const [call] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, executionId));
      expect(call.status).toBe('pending_approval');
      expect(await heldRows(executionId)).toHaveLength(0);
    }
  });

  test('a wipe sets input_enc to NULL and keeps the row', async () => {
    const executionId = await gate({ amount: 3 });
    await wipeHeldInput(executionId);
    const [row] = await heldRows(executionId);
    expect(row).toMatchObject({ inputEnc: null, state: 'held' });
    expect(await readHeldInput(executionId)).toBeNull();
  });

  test('a held write that fails keeps the gate and writes no held row', async () => {
    const executionId = await deps.recordExecution({
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      connectorId,
      connectionId,
      actionPath: 'billing.charges.create',
      actingUserId: humanUserId,
      sessionId,
      status: 'pending_approval',
      risk: 'write',
      requestDigest: 'a'.repeat(64),
      resultSummary: { reason: 'policy_require_approval' },
      // JSON.stringify throws on a BigInt: the held write fails before the insert.
      held: { connectorSlug: 'billing', actionPath: 'charges.create', args: { n: 1n }, approvalContext: null, policySet: null },
    });
    expect(executionId).toBeString();
    const [call] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, executionId!));
    expect(call.status).toBe('pending_approval');
    expect(await heldRows(executionId!)).toHaveLength(0);
  });

  test('no result_summary, approvals read or review read carries the held input', async () => {
    const executionId = await gate({ amount: 4, api_key: SENTINEL });
    const [held] = await heldRows(executionId);
    const [call] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, executionId));
    const responses = await Promise.all(
      [
        `/v1/projects/${seeded.project_id}/approvals`,
        `/v1/projects/${seeded.project_id}/review/items`,
        `/v1/projects/${seeded.project_id}/review/items/call:${executionId}`,
      ].map(authed),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const body of bodies) expect(body).toContain(executionId);
    const surfaces = [
      JSON.stringify(call.resultSummary),
      ...bodies,
      JSON.stringify(await listInboxItems(seeded.project_id, {}, asOwner, FULL_VIEW)),
      JSON.stringify(await getInboxItem(seeded.project_id, `call:${executionId}`, asOwner, FULL_VIEW)),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SENTINEL);
      expect(surface).not.toContain(held.inputEnc!);
      expect(surface).not.toContain('input_enc');
    }
  });
});
