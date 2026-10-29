/**
 * Approve runs the held call once, as its caller (real Postgres, loopback
 * provider stub). A gate from a project-scoped session token holds its input.
 * Approve flips the gate to `approved` and queues one job; the job worker runs
 * the call through the production gateway deps and resumes the session with
 * one `approval-run:` command that carries the redacted result.
 *
 * The provider stub counts calls: every refusal path below asserts that the
 * count did not move. A gate without a held row (a dashboard JWT caller) keeps
 * the carry-over: approve, then repeat the call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import {
  type AgentGrant,
  accountMembers,
  auditEvents,
  connectorActions,
  connectorCalls,
  connectorHeldCalls,
  connectorPolicies,
  connectors,
  jobQueue,
  sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import type { ApprovalEnricher } from '../connectors/approval-enrichers';
import type { CallResult, GatewayDeps } from '../connectors/gateway';
import type { ConnectorPrincipal } from '../connectors/router-contract';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

// The grant reconcile reads the project manifest from git. The suite has no
// upstream: keep the token's stored grant.
const realGrant = await import('../projects/lib/session-token-grant');
mock.module('../projects/lib/session-token-grant', () => ({
  ...realGrant,
  reconcileStoredSessionAgentGrant: async (input: { storedGrant?: AgentGrant | null }) => input.storedGrant ?? null,
}));

const { makeDbGatewayDeps } = await import('../connectors/db-deps-gateway');
const { resolveTokenPrincipal } = await import('../connectors/db-deps-principal');
const { handleCall } = await import('../connectors/gateway');
const { HELD_CALL_QUEUE, HELD_RUN_CEILING_MS, HELD_RUN_VISIBILITY_MS } = await import('../connectors/held-call-store');
const { runHeldCall, settleStuckHeldCall } = await import('../connectors/held-call-run');
const { APPROVAL_RERUN_RULE, heldCallRepeatInstructions, heldRunRule } = await import('../connectors/approval-expiry');
const { decideConnectorApproval, expireDueApprovals, loadApprovalRow } = await import(
  '../projects/lib/connector-approval-decision'
);
const { runApprovalExpiryTick } = await import('../workers/approval-expiry-worker');
const { consumeApprovedExecution } = await import('../connectors/db-deps-gateway');
const { createAccountToken } = await import('../repositories/account-tokens');
const { ensureDefaultConnection, upsertConnectionCredential } = await import('../connectors/credentials');
const { claimJobs, runJobBatch } = await import('../shared/job-queue');
const { getInboxItem } = await import('../projects/review-items');
const asManager = async () => ({
  isManager: true,
  callerUserId: ownerId,
  callerAuthType: 'supabase' as const,
  callerCredentialKind: 'jwt' as const,
  callerSessionId: null,
});
const FULL_VIEW = { where: () => undefined, allows: async () => true };

/** Credential-shaped: redaction must keep it out of every surface. */
const SENTINEL = 'held-run-sentinel-5d2e81';
const OUTPUT_SECRET = 'held-run-output-secret-9a4c';

let providerHits = 0;
let stub: ReturnType<typeof Bun.serve>;
let egressAllowHosts: readonly string[] = [];
let seeded: SeededProject;
const ownerId = crypto.randomUUID();
let sessionId = '';
let tokenSecret = '';
let connectorId = '';
let principal: ConnectorPrincipal;
let enrichers: Record<string, ApprovalEnricher> = {};

const depsFor = (p: ConnectorPrincipal): GatewayDeps => ({
  ...makeDbGatewayDeps(p),
  mintApprovalLink: undefined,
  postApprovalCard: undefined,
  approvalEnrichers: enrichers,
});

async function call(
  args: Record<string, unknown>,
  p: ConnectorPrincipal = principal,
  extra: Partial<GatewayDeps> = {},
): Promise<CallResult> {
  return handleCall({ ...depsFor(p), ...extra }, {
    projectId: seeded.project_id,
    accountId: seeded.account_id,
    subject: p.subject,
    sessionId: p.sessionId,
    actingTokenId: p.tokenId ?? null,
    connectorSlug: 'stub',
    actionPath: 'charges.create',
    args,
  });
}

async function gate(args: Record<string, unknown>, p: ConnectorPrincipal = principal): Promise<string> {
  const result = await call(args, p);
  if (result.status !== 'pending_approval' || !result.executionId) {
    throw new Error(`not held: ${JSON.stringify(result)}`);
  }
  return result.executionId;
}

async function decide(executionId: string, decision: 'approve' | 'deny') {
  const row = await loadApprovalRow(seeded.project_id, executionId);
  if (!row) throw new Error('no gate row');
  return decideConnectorApproval({
    projectId: seeded.project_id,
    accountId: seeded.account_id,
    row,
    decision,
    note: '',
    actorUserId: ownerId,
    auditSource: 'test',
    resume: 'queue',
  });
}

const run = (executionId: string) => runHeldCall(executionId, depsFor);
const held = async (executionId: string) =>
  (await db.select().from(connectorHeldCalls).where(eq(connectorHeldCalls.executionId, executionId)))[0];
const gateRow = async (executionId: string) =>
  (await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, executionId)))[0];
const resumes = (key: string) =>
  db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.idempotencyKey, key));

async function setPolicy(action: 'require_approval' | 'block'): Promise<void> {
  await db.update(connectorPolicies).set({ action }).where(eq(connectorPolicies.connectorId, connectorId));
}

beforeAll(async () => {
  egressAllowHosts = config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS;
  config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS = ['127.0.0.1', 'localhost'];
  stub = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/v1/charges') {
        providerHits += 1;
        return Response.json({ id: 'ch_test_1', client_secret: OUTPUT_SECRET }, { status: 201 });
      }
      return Response.json({ error: 'no route' }, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${stub.port}`;

  seeded = await seedProject('held-call-run');
  await insertIntoView(db, accountMembers, { accountId: seeded.account_id, userId: ownerId, accountRole: 'owner' });
  sessionId = await seedSession(seeded, ownerId);
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    status: 'active',
  });
  tokenSecret = (
    await createAccountToken({
      accountId: seeded.account_id,
      userId: ownerId,
      projectId: seeded.project_id,
      sessionId,
      name: 'held-call-run',
    })
  ).secretKey;

  const [connector] = await db
    .insert(connectors)
    .values({
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      slug: 'stub',
      name: 'Stub',
      providerType: 'openapi',
      enabled: true,
      status: 'active',
      config: { base_url: base, auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' } },
    })
    .returning();
  connectorId = connector.connectorId;
  await db.insert(connectorActions).values({
    connectorId,
    path: 'charges.create',
    name: 'Create charge',
    description: 'test action',
    inputSchema: { type: 'object' },
    risk: 'write',
    binding: { kind: 'openapi', method: 'POST', path: '/v1/charges', server: base },
  });
  const connectionId = await ensureDefaultConnection({ projectId: seeded.project_id, connectorId, createdBy: ownerId });
  await upsertConnectionCredential({ projectId: seeded.project_id, connectorId, connectionId, value: 'sk_test_held_run' });
  await db.insert(connectorPolicies).values({ connectorId, match: '*', action: 'require_approval' });

  const resolved = await resolveTokenPrincipal(tokenSecret, null);
  if (!resolved) throw new Error('session token did not resolve');
  principal = resolved;
}, 30_000);

beforeEach(async () => {
  enrichers = {};
  await setPolicy('require_approval');
});

afterAll(async () => {
  config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS = [...egressAllowHosts];
  stub?.stop(true);
  await db.delete(jobQueue).where(eq(jobQueue.queue, HELD_CALL_QUEUE));
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, seeded.project_id));
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, seeded.project_id));
  await db.delete(connectors).where(eq(connectors.projectId, seeded.project_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${seeded.account_id}`);
  await db.execute(sql`delete from kortix.session_sandboxes where account_id = ${seeded.account_id}`);
  await db.execute(sql`delete from kortix.project_sessions where project_id = ${seeded.project_id}`);
  await removeSeeded([seeded]);
}, 30_000);

describe('approve runs the held call once', () => {
  test('approve queues one job; the worker calls the provider once and resumes the session with the result', async () => {
    const id = await gate({ amount: 101, api_key: SENTINEL });
    expect((await held(id)).state).toBe('held');

    expect(await decide(id, 'approve')).toBe('resolved');
    expect((await gateRow(id)).status).toBe('approved');
    expect(await held(id)).toMatchObject({ state: 'queued' });
    expect((await held(id)).runDeadline).toBeInstanceOf(Date);
    const jobs = await db.select().from(jobQueue).where(and(eq(jobQueue.queue, HELD_CALL_QUEUE), eq(jobQueue.jobKey, id)));
    expect(jobs).toHaveLength(1);
    // The session is resumed after the run, not at decision time.
    expect(await resumes(`approval-resume:${id}`)).toHaveLength(0);

    const before = providerHits;
    await runJobBatch(4);
    expect(providerHits).toBe(before + 1);

    const row = await held(id);
    expect(row.state).toBe('ok');
    expect(row.inputEnc).toBeNull();
    expect(row.finishedAt).toBeInstanceOf(Date);
    const outcome = row.outcome as Record<string, unknown>;
    expect(outcome).toMatchObject({ status: 'ok', upstream_status: 201 });
    expect(String(outcome.output_preview)).toContain('ch_test_1');
    expect(String(outcome.output_preview)).not.toContain(OUTPUT_SECRET);

    // The run's own audit row names the gate and who approved it.
    const runRow = await gateRow(row.runExecutionId!);
    expect(runRow.status).toBe('ok');
    expect(runRow.resultSummary).toMatchObject({ approved_execution_id: id, approved_by: ownerId });
    const tagged = await db
      .select({ summary: connectorCalls.resultSummary })
      .from(connectorCalls)
      .where(sql`${connectorCalls.resultSummary} ->> 'approved_execution_id' = ${id}`);
    expect(tagged.map((r) => (r.summary as Record<string, unknown>).reason)).toContain('approved_hold');

    const commands = await resumes(`approval-run:${id}`);
    expect(commands).toHaveLength(1);
    expect(commands[0].source).toBe('system:approval-resume');
    const text = String((commands[0].payload as Record<string, unknown>).text);
    expect(text).toContain('ran once');
    expect(text).toContain('ch_test_1');

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'connector.approval.run'), eq(auditEvents.resourceId, id)));
    expect(event).toBeDefined();

    // The held input reaches no surface.
    for (const surface of [
      JSON.stringify(outcome),
      text,
      JSON.stringify(event),
      JSON.stringify(runRow.resultSummary),
      JSON.stringify((await gateRow(id)).resultSummary),
    ]) {
      expect(surface).not.toContain(SENTINEL);
      expect(surface).not.toContain(OUTPUT_SECRET);
    }

    // A manager in full view reads the item: the run carries status fields
    // only; the output and the account stay in the session's resume.
    const item = await getInboxItem(seeded.project_id, `call:${id}`, asManager, FULL_VIEW);
    const readRun = (item?.detail as { run?: { state: string; outcome: Record<string, unknown> | null } }).run;
    expect(readRun?.state).toBe('ok');
    expect(readRun?.outcome).toEqual({ status: 'ok', upstream_status: 201 });
    expect(JSON.stringify(item)).not.toContain('ch_test_1');

    // A second run of the same job is a no-op.
    await run(id);
    expect(providerHits).toBe(before + 1);
  });

  test('a settle that fails after dispatch retries in-process; no failure text carries the output', async () => {
    // A trigger fails the settle UPDATE the first `times` attempts. A sequence
    // counts across the rolled-back transactions.
    const failSettles = async (id: string, times: number) => {
      await db.execute(sql.raw(`
        drop sequence if exists kortix.test_settle_fail;
        create sequence kortix.test_settle_fail;
        create or replace function kortix.test_settle_fail() returns trigger language plpgsql as $$
        begin
          if new.execution_id = '${id}' and old.state = 'dispatched' and nextval('kortix.test_settle_fail') <= ${times} then
            raise exception 'forced settle failure' using errcode = '40001';
          end if;
          return new;
        end $$;
        drop trigger if exists test_settle_fail on kortix.connector_held_calls;
        create trigger test_settle_fail before update on kortix.connector_held_calls
          for each row execute function kortix.test_settle_fail();`));
    };
    const dropTrigger = () =>
      db.execute(sql.raw(`drop trigger if exists test_settle_fail on kortix.connector_held_calls;
        drop function if exists kortix.test_settle_fail(); drop sequence if exists kortix.test_settle_fail;`));
    const { logger } = await import('../lib/logger');
    const logged: string[] = [];
    const { warn, error } = logger;
    logger.warn = (...args: Parameters<typeof logger.warn>) => { logged.push(JSON.stringify(args)); };
    logger.error = (...args: Parameters<typeof logger.error>) => { logged.push(JSON.stringify(args)); };
    try {
      // Fails once, then succeeds: the outcome persists, the provider ran once.
      const once = await gate({ amount: 2101 });
      await decide(once, 'approve');
      await failSettles(once, 1);
      const before = providerHits;
      await run(once);
      expect(providerHits).toBe(before + 1);
      const row = await held(once);
      expect(row).toMatchObject({ state: 'ok', inputEnc: null });
      expect(String((row.outcome as Record<string, unknown>).output_preview)).toContain('ch_test_1');
      expect(await resumes(`approval-run:${once}`)).toHaveLength(1);

      // Fails every attempt: the job fails with a clean error, the row stays dispatched.
      const always = await gate({ amount: 2102 });
      await decide(always, 'approve');
      await failSettles(always, 100);
      await runJobBatch(4);
      expect((await held(always)).state).toBe('dispatched');
      const [job] = await db.select().from(jobQueue).where(and(eq(jobQueue.queue, HELD_CALL_QUEUE), eq(jobQueue.jobKey, always)));
      expect(job.lastError).toContain('held call settle failed');
      for (const text of [job.lastError ?? '', ...logged]) {
        expect(text).not.toContain('ch_test_1');
        expect(text).not.toContain('ran once');
        expect(text).not.toContain('forced settle failure');
      }
      expect(logged.join('\n')).toContain('40001');
    } finally {
      logger.warn = warn;
      logger.error = error;
      await dropTrigger();
    }
  });

  test('a failed run with a session: the item names the failure from its status fields, never the hidden message', async () => {
    const id = await gate({ amount: 506 });
    await decide(id, 'approve');
    await db
      .update(connectorHeldCalls)
      .set({
        state: 'error',
        outcome: { status: 'error', upstream_status: 500, message: 'upstream said ch_test_1' },
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(connectorHeldCalls.executionId, id));
    const item = await getInboxItem(seeded.project_id, `call:${id}`, asManager, FULL_VIEW);
    const detail = item?.detail as { run?: { outcome: Record<string, unknown> | null }; next_step?: string };
    expect(detail.run?.outcome).toEqual({ status: 'error', upstream_status: 500 });
    expect(detail.next_step).toContain('but failed (upstream 500).');
    expect(JSON.stringify(item)).not.toContain('ch_test_1');
  });

  test('two runs of one job call the provider once', async () => {
    const id = await gate({ amount: 202 });
    await decide(id, 'approve');
    const before = providerHits;
    await Promise.allSettled([run(id), run(id)]);
    await run(id).catch(() => {});
    expect(providerHits).toBe(before + 1);
    expect((await held(id)).state).toBe('ok');
  });

  test('a policy changed to block after the hold refuses the run', async () => {
    const id = await gate({ amount: 303 });
    await decide(id, 'approve');
    await setPolicy('block');
    const before = providerHits;
    await run(id);
    expect(providerHits).toBe(before);
    const row = await held(id);
    expect(row).toMatchObject({ state: 'refused', inputEnc: null });
    expect(row.outcome).toMatchObject({ status: 'refused', reason: 'policy_block' });
    const [command] = await resumes(`approval-run:${id}`);
    expect(String((command.payload as Record<string, unknown>).text)).toContain('did not run');
  });

  test('content changed after approval asks again with a new gate and does not run', async () => {
    let content = 'draft v1';
    enrichers = { 'openapi:stub.charges.create': async () => ({ body: content }) };
    const id = await gate({ amount: 404 });
    expect((await gateRow(id)).resultSummary).toHaveProperty('resolved_digest');
    await decide(id, 'approve');
    content = 'draft v2';
    const before = providerHits;
    await run(id);
    expect(providerHits).toBe(before);
    const row = await held(id);
    expect(row.state).toBe('refused');
    const outcome = row.outcome as Record<string, unknown>;
    expect(outcome.reason).toBe('content_changed');
    const newId = String(outcome.new_execution_id);
    expect(newId).not.toBe(id);
    expect((await gateRow(newId)).status).toBe('pending_approval');
    expect((await held(newId)).state).toBe('held');
  });

  test('a run that dispatched and never settled ends unknown and never runs again', async () => {
    const id = await gate({ amount: 505 });
    await decide(id, 'approve');
    await db
      .update(connectorHeldCalls)
      .set({ state: 'dispatched', dispatchedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectorHeldCalls.executionId, id));
    const before = providerHits;
    // Inside the run ceiling the job backs off.
    await expect(run(id)).rejects.toThrow('held call run in progress');
    await db
      .update(connectorHeldCalls)
      .set({ dispatchedAt: new Date(Date.now() - HELD_RUN_CEILING_MS - 60_000) })
      .where(eq(connectorHeldCalls.executionId, id));
    await run(id);
    await run(id);
    expect(providerHits).toBe(before);
    expect(await held(id)).toMatchObject({ state: 'unknown', inputEnc: null });
    const [command] = await resumes(`approval-run:${id}`);
    expect(String((command.payload as Record<string, unknown>).text)).toContain('may have run');
  });

  test('a replica that dies after the fence: the queue re-claim settles unknown, the job ends done', async () => {
    const id = await gate({ amount: 515 });
    await decide(id, 'approve');
    // Earlier tests ran their jobs directly; only this job may be claimed.
    await db.delete(jobQueue).where(and(eq(jobQueue.queue, HELD_CALL_QUEUE), sql`${jobQueue.jobKey} <> ${id}`));
    // The dead replica claimed the job and fenced the row, then died. The
    // queue claims a job again only after its visibility.
    expect(HELD_RUN_CEILING_MS).toBeLessThan(HELD_RUN_VISIBILITY_MS);
    const [claimed] = await claimJobs([HELD_CALL_QUEUE], 1, HELD_RUN_VISIBILITY_MS);
    expect(claimed.jobKey).toBe(id);
    const fencedAt = new Date(Date.now() - HELD_RUN_VISIBILITY_MS + 5_000);
    await db
      .update(connectorHeldCalls)
      .set({ state: 'dispatched', dispatchedAt: fencedAt, updatedAt: fencedAt })
      .where(eq(connectorHeldCalls.executionId, id));
    await db
      .update(jobQueue)
      .set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(jobQueue.jobId, claimed.jobId));

    const before = providerHits;
    for (let i = 0; i < 5 && (await held(id)).state === 'dispatched'; i++) await runJobBatch(4);
    expect(providerHits).toBe(before);
    expect(await held(id)).toMatchObject({ state: 'unknown', inputEnc: null });
    const [job] = await db.select().from(jobQueue).where(eq(jobQueue.jobId, claimed.jobId));
    expect(job).toMatchObject({ status: 'done', attempts: 2 });
    expect(await resumes(`approval-run:${id}`)).toHaveLength(1);
  });

  test('a repeat after the run window passed opens a new gate', async () => {
    const args = { amount: 616 };
    const id = await gate(args);
    await decide(id, 'approve');
    // The job died before the fence: the row stays queued past its deadline.
    await db
      .update(connectorHeldCalls)
      .set({ runDeadline: new Date(Date.now() - 1_000) })
      .where(eq(connectorHeldCalls.executionId, id));
    const repeat = await call(args);
    expect(repeat.status).toBe('pending_approval');
    if (repeat.status !== 'pending_approval') return;
    expect(repeat.executionId).not.toBe(id);
    expect(repeat.approvalInstructions ?? '').not.toContain('already waiting');
    expect((await held(repeat.executionId!)).state).toBe('held');
  });

  test('a request whose re-injected digest drifted is refused request_changed', async () => {
    const id = await gate({ amount: 606 });
    await decide(id, 'approve');
    const [action] = await db.select().from(connectorActions).where(eq(connectorActions.connectorId, connectorId));
    const binding = action.binding as Record<string, unknown>;
    await db
      .update(connectorActions)
      .set({ binding: { ...binding, path: '/v1/charges/v2' } })
      .where(eq(connectorActions.connectorId, connectorId));
    const before = providerHits;
    try {
      await run(id);
    } finally {
      await db.update(connectorActions).set({ binding }).where(eq(connectorActions.connectorId, connectorId));
    }
    expect(providerHits).toBe(before);
    expect((await held(id)).outcome).toMatchObject({ status: 'refused', reason: 'request_changed' });
  });

  test('deny wipes the held input and queues no run', async () => {
    const id = await gate({ amount: 707 });
    await decide(id, 'deny');
    expect(await held(id)).toMatchObject({ state: 'cancelled', inputEnc: null });
    expect(await db.select().from(jobQueue).where(eq(jobQueue.jobKey, id))).toHaveLength(0);
    const before = providerHits;
    await run(id);
    expect(providerHits).toBe(before);
  });

  test('expiry wipes the held input', async () => {
    const id = await gate({ amount: 808 });
    await db
      .update(connectorCalls)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(connectorCalls.executionId, id));
    await expireDueApprovals();
    expect((await gateRow(id)).status).toBe('expired');
    expect(await held(id)).toMatchObject({ state: 'cancelled', inputEnc: null });
  });

  test('an agent repeat while held or queued gets the same execution id, no second gate', async () => {
    const args = { amount: 909 };
    const id = await gate(args);
    const again = await call(args);
    expect(again).toMatchObject({ status: 'pending_approval', executionId: id });
    if (again.status === 'pending_approval')
      expect(again.approvalInstructions).toBe(
        heldCallRepeatInstructions({ projectId: seeded.project_id, executionId: id, sessionId }),
      );
    await decide(id, 'approve');
    expect(await call(args)).toMatchObject({ status: 'pending_approval', executionId: id });
    const gates = await db
      .select()
      .from(connectorCalls)
      .where(and(eq(connectorCalls.projectId, seeded.project_id), sql`${connectorCalls.resultSummary} -> 'args_preview' ->> 'amount' = '909'`));
    expect(gates).toHaveLength(1);
    const before = providerHits;
    await run(id);
    expect(providerHits).toBe(before + 1);
  });

  test('gate-time instructions match the gate: a held call runs on approval, a JWT caller repeats it', async () => {
    const withLink = { mintApprovalLink: async () => 'https://app.kortix.test/approve/synthetic' };
    const heldGate = await call({ amount: 1101 }, principal, withLink);
    expect(heldGate).toMatchObject({ status: 'pending_approval', runsOnApproval: true });
    if (heldGate.status !== 'pending_approval') return;
    expect(heldGate.approvalInstructions).toStartWith(
      `Share approval_url with a human, then stop this turn. ${heldRunRule({ projectId: seeded.project_id, executionId: heldGate.executionId!, sessionId })}`,
    );
    expect(heldGate.approvalInstructions).not.toContain(APPROVAL_RERUN_RULE);

    const jwtGate = await call({ amount: 1102 }, { ...principal, tokenId: null, sessionId: null }, withLink);
    expect(jwtGate.status).toBe('pending_approval');
    if (jwtGate.status !== 'pending_approval') return;
    expect(jwtGate.runsOnApproval).toBeUndefined();
    expect(jwtGate.approvalInstructions).toStartWith(`Share approval_url with a human. ${APPROVAL_RERUN_RULE}`);
  });

  test('the kill switch off: a project-token gate writes no held row and asks for the repeat', async () => {
    const withLink = { mintApprovalLink: async () => 'https://app.kortix.test/approve/synthetic' };
    config.KORTIX_APPROVAL_RUNS_HELD_CALL = false;
    try {
      const off = await call({ amount: 1201 }, principal, withLink);
      expect(off.status).toBe('pending_approval');
      if (off.status !== 'pending_approval') return;
      expect(off.runsOnApproval).toBeUndefined();
      expect(await held(off.executionId!)).toBeUndefined();
      expect(off.approvalInstructions).toContain(APPROVAL_RERUN_RULE);
    } finally {
      config.KORTIX_APPROVAL_RUNS_HELD_CALL = true;
    }
    const on = await call({ amount: 1202 }, principal, withLink);
    expect(on).toMatchObject({ status: 'pending_approval', runsOnApproval: true });
    if (on.status !== 'pending_approval') return;
    expect(await held(on.executionId!)).toBeDefined();
  });

  test('a gate with no held row (dashboard JWT caller) keeps the carry-over', async () => {
    const jwtCaller: ConnectorPrincipal = { ...principal, tokenId: null, sessionId: null };
    const args = { amount: 1001 };
    const id = await gate(args, jwtCaller);
    expect(await held(id)).toBeUndefined();
    await decide(id, 'approve');
    expect((await gateRow(id)).status).toBe('ok');
    expect(await db.select().from(jobQueue).where(eq(jobQueue.jobKey, id))).toHaveLength(0);
    const before = providerHits;
    const repeat = await call(args, jwtCaller);
    expect(repeat.status).toBe('ok');
    expect(providerHits).toBe(before + 1);
    expect((await gateRow(id)).resultSummary).toHaveProperty('consumed_at');
  });
});

describe('the approval-expiry tick closes the held-call lifecycle', () => {
  const DAY_MS = 24 * 3600_000;
  const jobOf = (id: string) => and(eq(jobQueue.queue, HELD_CALL_QUEUE), eq(jobQueue.jobKey, id));
  const killJob = (id: string) => db.update(jobQueue).set({ status: 'dead' }).where(jobOf(id));

  test('a pending held gate past expires_at: the tick expires it and wipes the input', async () => {
    const id = await gate({ amount: 1201 });
    await db.update(connectorCalls).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(connectorCalls.executionId, id));
    await runApprovalExpiryTick();
    expect((await gateRow(id)).status).toBe('expired');
    expect(await held(id)).toMatchObject({ state: 'cancelled', inputEnc: null });
  });

  test('a dispatched row past the run ceiling with a dead job settles unknown once, never runs again', async () => {
    const id = await gate({ amount: 1202 });
    await decide(id, 'approve');
    await killJob(id);
    const fencedAt = new Date(Date.now() - HELD_RUN_CEILING_MS - 60_000);
    await db
      .update(connectorHeldCalls)
      .set({ state: 'dispatched', dispatchedAt: fencedAt, updatedAt: fencedAt })
      .where(eq(connectorHeldCalls.executionId, id));
    const before = providerHits;
    await runApprovalExpiryTick();
    await runApprovalExpiryTick();
    expect(providerHits).toBe(before);
    const row = await held(id);
    expect(row).toMatchObject({ state: 'unknown', inputEnc: null });
    expect(row.outcome).toMatchObject({ status: 'unknown', reason: 'run_interrupted' });
    expect(await resumes(`approval-run:${id}`)).toHaveLength(1);
  });

  test('a queued row past its run deadline settles refused/run_window_passed only when its job is dead', async () => {
    const id = await gate({ amount: 1203 });
    await decide(id, 'approve');
    await db
      .update(connectorHeldCalls)
      .set({ runDeadline: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(connectorHeldCalls.executionId, id));
    // The job is still queued: the job, not the sweep, settles the row.
    await runApprovalExpiryTick();
    expect((await held(id)).state).toBe('queued');

    await killJob(id);
    const before = providerHits;
    await runApprovalExpiryTick();
    await runApprovalExpiryTick();
    expect(providerHits).toBe(before);
    const row = await held(id);
    expect(row).toMatchObject({ state: 'refused', inputEnc: null });
    expect(row.outcome).toMatchObject({ status: 'refused', reason: 'run_window_passed' });
    expect(await resumes(`approval-run:${id}`)).toHaveLength(1);
  });

  test('the sweep never runs a call, even when the API clock is behind the database clock', async () => {
    const id = await gate({ amount: 1209 });
    await decide(id, 'approve');
    await killJob(id);
    // Past in database time (the sweep's selection), still ahead in the API clock below.
    await db
      .update(connectorHeldCalls)
      .set({ runDeadline: sql`now() - interval '1 second'`, updatedAt: new Date() })
      .where(eq(connectorHeldCalls.executionId, id));
    const deadline = (await held(id)).runDeadline!;
    const before = providerHits;
    setSystemTime(new Date(deadline.getTime() - 60_000));
    try {
      await runApprovalExpiryTick();
    } finally {
      setSystemTime();
    }
    expect(providerHits).toBe(before);
    const row = await held(id);
    expect(row).toMatchObject({ state: 'refused', inputEnc: null });
    expect(row.outcome).toMatchObject({ status: 'refused', reason: 'run_window_passed' });
    expect(await resumes(`approval-run:${id}`)).toHaveLength(1);
  });

  test('the fence checks the run deadline in database time: an app clock behind it never runs the call', async () => {
    const id = await gate({ amount: 1214 });
    await decide(id, 'approve');
    await db
      .update(connectorHeldCalls)
      .set({ runDeadline: sql`now() - interval '1 second'`, updatedAt: new Date() })
      .where(eq(connectorHeldCalls.executionId, id));
    const deadline = (await held(id)).runDeadline!;
    const before = providerHits;
    setSystemTime(new Date(deadline.getTime() - 60_000));
    try {
      await run(id);
    } finally {
      setSystemTime();
    }
    expect(providerHits).toBe(before);
    const row = await held(id);
    expect(row).toMatchObject({ state: 'refused', inputEnc: null });
    expect(row.outcome).toMatchObject({ status: 'refused', reason: 'run_window_passed' });
    expect(await resumes(`approval-run:${id}`)).toHaveLength(1);
  });

  test('a stuck settle selected as queued leaves a row its worker fenced since then', async () => {
    const id = await gate({ amount: 1215 });
    await decide(id, 'approve');
    // The sweep selected `queued`; a worker fenced the row before the settle.
    await db
      .update(connectorHeldCalls)
      .set({ state: 'dispatched', dispatchedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectorHeldCalls.executionId, id));
    await settleStuckHeldCall(id, 'queued');
    const row = await held(id);
    expect(row.state).toBe('dispatched');
    expect(row.inputEnc).not.toBeNull();
    expect(await resumes(`approval-run:${id}`)).toHaveLength(0);
  });

  test('the 31-day backstop wipes held input in every state; a held row ends cancelled', async () => {
    const terminal = await gate({ amount: 1204 });
    const stillHeld = await gate({ amount: 1205 });
    const young = await gate({ amount: 1206 });
    const old = new Date(Date.now() - 32 * DAY_MS);
    // A terminal row that kept its input (no writer leaves one; the backstop must still wipe it).
    await db
      .update(connectorHeldCalls)
      .set({ state: 'error', createdAt: old, updatedAt: old })
      .where(eq(connectorHeldCalls.executionId, terminal));
    await db.update(connectorHeldCalls).set({ createdAt: old }).where(eq(connectorHeldCalls.executionId, stillHeld));
    await db
      .update(connectorHeldCalls)
      .set({ state: 'error', updatedAt: new Date() })
      .where(eq(connectorHeldCalls.executionId, young));

    await runApprovalExpiryTick();
    expect(await held(terminal)).toMatchObject({ state: 'error', inputEnc: null });
    const cancelled = await held(stillHeld);
    expect(cancelled).toMatchObject({ state: 'cancelled', inputEnc: null });
    expect(cancelled.finishedAt).toBeInstanceOf(Date);
    // Younger than 31 days: untouched.
    expect((await held(young)).inputEnc).not.toBeNull();
  });

  test('a held row whose gate an old replica closed ends cancelled with its input wiped, no resume', async () => {
    const decidedOk = await gate({ amount: 1210 });
    const denied = await gate({ amount: 1211 });
    const expired = await gate({ amount: 1212 });
    const pending = await gate({ amount: 1213 });
    // An old replica writes the gate only; the held row stays `held` with its input.
    await db.update(connectorCalls).set({ status: 'ok' }).where(eq(connectorCalls.executionId, decidedOk));
    await db.update(connectorCalls).set({ status: 'denied' }).where(eq(connectorCalls.executionId, denied));
    await db.update(connectorCalls).set({ status: 'expired' }).where(eq(connectorCalls.executionId, expired));

    const before = providerHits;
    await runApprovalExpiryTick();
    expect(providerHits).toBe(before);
    for (const id of [decidedOk, denied, expired]) {
      const row = await held(id);
      expect(row).toMatchObject({ state: 'cancelled', inputEnc: null });
      expect(row.finishedAt).toBeInstanceOf(Date);
      expect(await resumes(`approval-run:${id}`)).toHaveLength(0);
    }
    // A gate still pending keeps its held row.
    expect(await held(pending)).toMatchObject({ state: 'held' });
    expect((await held(pending)).inputEnc).not.toBeNull();
  });

  test('the audit projection of an approved gate reads success, not failure', async () => {
    const id = await gate({ amount: 1208 });
    await decide(id, 'approve');
    const events = await db
      .select({ phase: auditEvents.phase, outcome: auditEvents.outcome })
      .from(auditEvents)
      .where(and(eq(auditEvents.sourceLedger, 'connector_calls'), eq(auditEvents.sourceRecordId, id)));
    expect(events).toContainEqual({ phase: 'approved', outcome: 'success' });
  });

  test('carry-over never claims a gate that has a held row', async () => {
    const id = await gate({ amount: 1207 });
    // A held row without its input: approve takes the carry-over branch and flips the gate to `ok`.
    await db.update(connectorHeldCalls).set({ inputEnc: null }).where(eq(connectorHeldCalls.executionId, id));
    await decide(id, 'approve');
    const row = await gateRow(id);
    expect(row.status).toBe('ok');
    expect(
      await consumeApprovedExecution({
        sessionId: row.sessionId,
        actingUserId: row.actingUserId!,
        connectorId: row.connectorId!,
        actionPath: row.actionPath,
        requestDigest: row.requestDigest!,
      }),
    ).toBe(false);
    expect((await gateRow(id)).resultSummary).not.toHaveProperty('consumed_at');
  });

  test('the held-row and job checks correlate to the row itself, not to any row of the inner table', async () => {
    // A: a held gate approved through the carry-over branch (held row, input wiped).
    const a = await gate({ amount: 1208 });
    await db.update(connectorHeldCalls).set({ inputEnc: null }).where(eq(connectorHeldCalls.executionId, a));
    await decide(a, 'approve');
    // B: a JWT gate for another digest, approved, no held row.
    const jwtCaller: ConnectorPrincipal = { ...principal, tokenId: null, sessionId: null };
    const bArgs = { amount: 1209 };
    const b = await gate(bArgs, jwtCaller);
    expect(await held(b)).toBeUndefined();
    await decide(b, 'approve');

    const before = providerHits;
    expect((await call(bArgs, jwtCaller)).status).toBe('ok');
    expect(providerHits).toBe(before + 1);
    expect((await gateRow(b)).resultSummary).toHaveProperty('consumed_at');
    const rowA = await gateRow(a);
    expect(
      await consumeApprovedExecution({
        sessionId: rowA.sessionId,
        actingUserId: rowA.actingUserId!,
        connectorId: rowA.connectorId!,
        actionPath: rowA.actionPath,
        requestDigest: rowA.requestDigest!,
      }),
    ).toBe(false);

    // Two queued rows past their deadline: only the one whose own job is dead settles.
    const dead = await gate({ amount: 1210 });
    const live = await gate({ amount: 1211 });
    await decide(dead, 'approve');
    await decide(live, 'approve');
    await db
      .update(connectorHeldCalls)
      .set({ runDeadline: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(sql`${connectorHeldCalls.executionId} in (${dead}, ${live})`);
    await killJob(dead);
    await runApprovalExpiryTick();
    expect((await held(dead)).state).toBe('refused');
    expect((await held(live)).state).toBe('queued');
  });
});
