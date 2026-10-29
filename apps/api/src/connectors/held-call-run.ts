/**
 * The approved held call runs here, once, as its original caller. Approve
 * (`decideConnectorApproval`) flips the gate to `approved`, the held row to
 * `queued`, and enqueues one `connector-held-call` job keyed by the execution
 * id, all in one commit. This handler:
 *
 *   1. ends a finished row; a `dispatched` row that outlived the run ceiling
 *      settles `unknown` (it may have run; never run again); a row past its
 *      `run_deadline` settles `refused/run_window_passed`;
 *   2. decrypts the held input and rebuilds the caller (refusal = `refused`);
 *   3. fences `queued` → `dispatched` while `run_deadline` is ahead in
 *      database time (0 rows: another run owns it, or the window passed);
 *   4. runs `handleCall` with `heldApproval`: policy is evaluated again, block
 *      wins, and the re-injected request must give the approved digest;
 *   5. settles the redacted outcome, wipes the input, and enqueues the
 *      `approval-run:<id>` resume in the same commit; then updates the chat
 *      card, if one was posted, with the run's status.
 *
 * A crash between 3 and 5 is the only `unknown` window. The held input never
 * leaves this module: only `output_preview` (≤ 4 KB, redacted) and error text
 * (≤ 500 chars) go to the outcome, the resume text and the audit event.
 */
import { connectorCalls, connectorHeldCalls, sessionLifecycleCommands } from '@kortix/db';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from '../projects/surface';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import { registerJobHandler } from '../shared/job-queue';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { buildArgsPreviewDetails } from './args-preview';
import { approvalRunAuditEvent } from './call-audit';
import { rebuildHeldCallPrincipal } from './db-deps-principal';
import { makeDbGatewayDeps } from './db-deps-gateway';
import { type CallResult, type GatewayDeps, handleCall } from './gateway';
import {
  HELD_CALL_QUEUE,
  HELD_RUN_CEILING_MS,
  HELD_RUN_VISIBILITY_MS,
  HeldInputRefusedError,
  openHeldInput,
} from './held-call-store';
import type { ConnectorPrincipal } from './router-contract';

const MAX_OUTPUT_PREVIEW = 4_096;
const MAX_MESSAGE = 500;

type FinalState = 'ok' | 'error' | 'refused' | 'unknown';

/** Redacted run result, the only part of a held call that leaves its row. */
export interface HeldRunOutcome {
  status: FinalState;
  reason?: string;
  message?: string;
  upstream_status?: number | null;
  account?: { label: string; id: string };
  output_preview?: string;
  new_execution_id?: string | null;
}

interface HeldRunRow {
  executionId: string;
  state: string;
  inputEnc: string | null;
  dispatchedAt: Date | null;
  runDeadline: Date | null;
  projectId: string;
  accountId: string;
  sessionId: string | null;
  connectorId: string | null;
  actionPath: string;
  requestDigest: string | null;
  approvedBy: string | null;
  chatDecider: Record<string, unknown> | null;
}

const TERMINAL = new Set(['ok', 'error', 'refused', 'unknown', 'cancelled']);

/**
 * Run one approved held call. `makeDeps` is the gateway deps factory (tests
 * wrap it). Throws only to retry later: a transient error before the fence, or
 * a `dispatched` row still inside the run ceiling.
 */
export async function runHeldCall(
  executionId: string,
  makeDeps: (principal: ConnectorPrincipal) => GatewayDeps = makeDbGatewayDeps,
): Promise<void> {
  const row = await loadHeldRun(executionId);
  if (!row || row.state === 'held' || TERMINAL.has(row.state)) return;
  if (row.state === 'dispatched') {
    // Only a concurrent direct call lands here: a queue re-claim comes after
    // the visibility, when the row is already past the ceiling.
    if (row.dispatchedAt && Date.now() - row.dispatchedAt.getTime() < HELD_RUN_CEILING_MS) {
      throw new Error('held call run in progress');
    }
    await settle(row, 'dispatched', { status: 'unknown', reason: 'run_interrupted' }, null);
    return;
  }
  if (!row.runDeadline || Date.now() > row.runDeadline.getTime()) {
    await settle(row, 'queued', { status: 'refused', reason: 'run_window_passed' }, null);
    return;
  }
  if (!row.inputEnc) {
    await settle(row, 'queued', { status: 'refused', reason: 'held_input_missing' }, null);
    return;
  }

  let held: ReturnType<typeof openHeldInput>;
  try {
    held = openHeldInput(
      { executionId, projectId: row.projectId, requestDigest: row.requestDigest },
      row.inputEnc,
    );
  } catch (error) {
    if (!(error instanceof HeldInputRefusedError)) throw error;
    await settle(row, 'queued', { status: 'refused', reason: error.reason }, null);
    return;
  }
  const caller = await rebuildHeldCallPrincipal(held);
  if (!caller.ok) {
    await settle(row, 'queued', { status: 'refused', reason: caller.reason }, null);
    return;
  }

  // At-most-once fence: only the run that moves the row out of `queued` calls
  // the provider. The deadline is checked again in database time: the app
  // clock can be behind.
  const fenced = await db
    .update(connectorHeldCalls)
    .set({ state: 'dispatched', dispatchedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(connectorHeldCalls.executionId, executionId),
        eq(connectorHeldCalls.state, 'queued'),
        sql`${connectorHeldCalls.runDeadline} > now()`,
      ),
    )
    .returning({ id: connectorHeldCalls.executionId });
  if (fenced.length === 0) {
    // Still `queued`: the deadline failed the fence. Otherwise another run owns the row.
    if ((await loadHeldRun(executionId))?.state === 'queued') {
      await settle(row, 'queued', { status: 'refused', reason: 'run_window_passed' }, null);
    }
    return;
  }

  const { principal, policySet } = caller;
  const base = makeDeps(principal);
  let lastRecorded: string | null = null;
  const deps: GatewayDeps = {
    ...base,
    recordExecution: async (rec) => {
      const id = await base.recordExecution(rec);
      if (id) lastRecorded = id;
      return id;
    },
  };
  let result: CallResult;
  try {
    result = await handleCall(deps, {
      projectId: held.project_id,
      accountId: principal.accountId,
      subject: principal.subject,
      sessionId: principal.sessionId,
      // The live token: after a re-mint it is not the token the call was held with.
      actingTokenId: principal.tokenId ?? null,
      connectorSlug: held.connector_slug,
      actionPath: held.action_path,
      args: held.args,
      approvalContext: held.approval_context,
      policySet,
      heldApproval: { executionId, approvedBy: row.approvedBy },
    });
  } catch (error) {
    logger.warn('[approvals] held call run threw after dispatch', {
      executionId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    await settleAfterDispatch(row, { status: 'unknown', reason: 'run_failed' }, lastRecorded);
    return;
  }
  const outcome = outcomeOf(result);
  await settleAfterDispatch(row, outcome, result.status === 'pending_approval' ? null : lastRecorded);
}

const SETTLE_ATTEMPTS = 3;

/**
 * The provider already ran: retry the settle in-process. A failed query's
 * message carries its params (the output preview, the resume text), so the
 * log and the thrown error name only the error class and the pg code. A row
 * that stays `dispatched` settles `unknown` through the sweep.
 */
async function settleAfterDispatch(row: HeldRunRow, outcome: HeldRunOutcome, runExecutionId: string | null): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await settle(row, 'dispatched', outcome, runExecutionId);
      return;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
      const code = typeof cause?.code === 'string' ? cause.code : null;
      logger.warn('[approvals] held call settle failed', { executionId: row.executionId, attempt, error: name, code });
      if (attempt >= SETTLE_ATTEMPTS) throw new Error(`held call settle failed (${name}${code ? ` ${code}` : ''})`);
    }
  }
}

async function loadHeldRun(executionId: string): Promise<HeldRunRow | null> {
  const [row] = await db
    .select({
      executionId: connectorHeldCalls.executionId,
      state: connectorHeldCalls.state,
      inputEnc: connectorHeldCalls.inputEnc,
      dispatchedAt: connectorHeldCalls.dispatchedAt,
      runDeadline: connectorHeldCalls.runDeadline,
      projectId: connectorCalls.projectId,
      accountId: connectorCalls.accountId,
      sessionId: connectorCalls.sessionId,
      connectorId: connectorCalls.connectorId,
      actionPath: connectorCalls.actionPath,
      requestDigest: connectorCalls.requestDigest,
      approvedBy: connectorCalls.approvedBy,
      chatDecider: connectorHeldCalls.chatDecider,
    })
    .from(connectorHeldCalls)
    .innerJoin(connectorCalls, eq(connectorCalls.executionId, connectorHeldCalls.executionId))
    .where(eq(connectorHeldCalls.executionId, executionId))
    .limit(1);
  return row ?? null;
}

/** The redacted outcome of one gateway result. */
function outcomeOf(result: CallResult): HeldRunOutcome {
  switch (result.status) {
    case 'ok':
      return {
        status: result.upstreamError ? 'error' : 'ok',
        ...(result.upstreamError ? { message: result.upstreamError.slice(0, MAX_MESSAGE) } : {}),
        upstream_status: result.upstreamStatus,
        ...(result.account ? { account: { label: result.account.label, id: result.account.connection_id } } : {}),
        output_preview: outputPreview(result.output),
      };
    case 'error':
      return {
        status: 'error',
        message: result.reason.slice(0, MAX_MESSAGE),
        ...(result.upstreamStatus === undefined ? {} : { upstream_status: result.upstreamStatus }),
      };
    case 'denied':
      return {
        status: 'refused',
        reason: result.reason.slice(0, MAX_MESSAGE),
        ...(result.message ? { message: result.message.slice(0, MAX_MESSAGE) } : {}),
      };
    case 'pending_approval':
      // The content changed after approval: a new gate asks a human again.
      return { status: 'refused', reason: result.reason, new_execution_id: result.executionId ?? null };
  }
}

/** The call output with credential-shaped fields redacted, as JSON, at most 4 KB. */
function outputPreview(output: unknown): string {
  const preview = buildArgsPreviewDetails({ output }).preview?.output ?? null;
  const text = JSON.stringify(preview) ?? 'null';
  return text.length > MAX_OUTPUT_PREVIEW ? `${text.slice(0, MAX_OUTPUT_PREVIEW)}… [truncated]` : text;
}

/** The prompt that tells the agent what its approved call did. */
export function heldRunResumeText(actionPath: string, outcome: HeldRunOutcome): string {
  switch (outcome.status) {
    case 'ok':
      return `Your approved call ${actionPath} ran once. Do not repeat it. Result:\n${outcome.output_preview ?? 'null'}`;
    case 'error':
      return `Your approved call ${actionPath} ran, but failed: ${outcome.message ?? 'unknown error'}. Check its effect before you repeat it.`;
    case 'unknown':
      return `Your approved call ${actionPath} may have run: Kortix lost track of it. Check its effect before you repeat it.`;
    case 'refused':
      return outcome.reason === 'content_changed'
        ? `Your approved call ${actionPath} did not run: the content changed after approval. A new approval ${outcome.new_execution_id ?? ''} is waiting for a human. Do not repeat the call.`
        : `Your approved call ${actionPath} did not run: ${outcome.message ?? outcome.reason ?? 'refused'}. Repeat the call to ask for approval again.`;
  }
}

/** A decision pressed on a chat card names the thread to answer in (server-written at decide time). */
function withReplyTarget(text: string, chatDecider: Record<string, unknown> | null): string {
  const replyTo = chatDecider?.reply_to;
  return typeof replyTo === 'string' && replyTo ? `${text}\n\n${replyTo}` : text;
}

/**
 * Settle the held row from `from` to the outcome's state, wipe its input, and
 * enqueue the session resume in the same commit. A row another run already
 * settled matches 0 rows: nothing else happens.
 */
async function settle(
  row: HeldRunRow,
  from: 'queued' | 'dispatched',
  outcome: HeldRunOutcome,
  runExecutionId: string | null,
): Promise<void> {
  const now = new Date();
  const idempotencyKey = `approval-run:${row.executionId}`;
  const settled = await db.transaction(async (tx) => {
    const done = await tx
      .update(connectorHeldCalls)
      .set({
        state: outcome.status,
        outcome: outcome as unknown as Record<string, unknown>,
        runExecutionId,
        inputEnc: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(connectorHeldCalls.executionId, row.executionId), eq(connectorHeldCalls.state, from)))
      .returning({ id: connectorHeldCalls.executionId });
    if (done.length === 0) return false;
    if (row.sessionId) {
      await tx
        .insert(sessionLifecycleCommands)
        .values(
          buildContinueSessionCommandValues({
            source: 'system:approval-resume',
            projectId: row.projectId,
            accountId: row.accountId,
            sessionId: row.sessionId,
            actorUserId: row.approvedBy,
            text: withReplyTarget(heldRunResumeText(row.actionPath, outcome), row.chatDecider),
            executionId: row.executionId,
            availableAt: now,
            idempotencyKey,
          }),
        )
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    return true;
  });
  if (!settled) return;

  try {
    await recordAuditEvent(
      approvalRunAuditEvent({
        accountId: row.accountId,
        projectId: row.projectId,
        sessionId: row.sessionId,
        executionId: row.executionId,
        actionPath: row.actionPath,
        connectorId: row.connectorId,
        approvedBy: row.approvedBy,
        state: outcome.status,
        reason: outcome.reason ?? null,
        runExecutionId,
      }),
    );
  } catch (error) {
    logger.warn('[approvals] failed to record held run audit event', { error: String(error) });
  }
  // Best-effort immediate delivery; the durable command above is the resume.
  if (row.sessionId) void drainSessionLifecycleQueue({ limit: 1, idempotencyKey }).catch(() => {});
  // The chat card (Slack, Teams) shows how the run ended, status only. Lazy
  // import: channels import connectors.
  void import('../channels/approval-card-relay')
    .then((relay) => relay.markApprovalCardRan(row.projectId, row.executionId))
    .catch((error) => logger.warn('[approvals] held run card update failed', { error: String(error) }));
}

const SWEEP_BATCH = 200;
/** Held input never outlives this: approvals.ttl is at most 30 days. */
const HELD_INPUT_MAX_AGE_DAYS = 31;

/**
 * Settle a stuck run without running it: never decrypts, rebuilds a principal,
 * fences or calls the provider. It settles from the state the sweep
 * `selected` only: `dispatched` → `unknown/run_interrupted`; `queued` →
 * `refused/run_window_passed`. The same settle as the job (state CAS, wipe,
 * one `approval-run:` resume, audit event, card update).
 */
export async function settleStuckHeldCall(executionId: string, selected: 'queued' | 'dispatched'): Promise<void> {
  const row = await loadHeldRun(executionId);
  if (!row) return;
  // Settle only from the state the sweep selected: a row fenced since then belongs to its worker.
  await settle(
    row,
    selected,
    selected === 'dispatched' ? { status: 'unknown', reason: 'run_interrupted' } : { status: 'refused', reason: 'run_window_passed' },
    null,
  );
}

/**
 * The approval-expiry tick's backstop for held calls, in three steps.
 *
 *   1. A row stuck in the run: `dispatched` past the run ceiling, or `queued`
 *      past its run deadline, whose job is no longer queued (dead after its
 *      last attempt, or gone). `settleStuckHeldCall` settles it (`unknown`
 *      or `refused/run_window_passed`) and never runs the call. The row is
 *      selected by database time only. A row older than 31 days settles
 *      even with a queued job.
 *   2. A `held` row whose gate is no longer `pending_approval` ends
 *      `cancelled` with its input wiped: an old replica decided, denied or
 *      expired the gate without touching the row (and already resumed).
 *   3. Held input older than 31 days is wiped in every state; a `held` row
 *      also ends `cancelled`.
 *
 * Returns the number of rows settled or wiped.
 */
export async function sweepHeldCalls(): Promise<number> {
  const old = sql`now() - make_interval(days => ${HELD_INPUT_MAX_AGE_DAYS})`;
  const jobGoneOrOld = or(
    sql`NOT EXISTS (SELECT 1 FROM kortix.job_queue j WHERE j.queue = ${HELD_CALL_QUEUE}
      AND j.job_key = ${qualifiedColumn(connectorHeldCalls.executionId)}::text AND j.status = 'queued')`,
    lt(connectorHeldCalls.createdAt, old),
  );
  const stuck = await db
    .select({ id: connectorHeldCalls.executionId, state: connectorHeldCalls.state })
    .from(connectorHeldCalls)
    .where(
      and(
        or(
          and(
            eq(connectorHeldCalls.state, 'dispatched'),
            lt(connectorHeldCalls.dispatchedAt, sql`now() - make_interval(secs => ${HELD_RUN_CEILING_MS / 1000})`),
          ),
          and(
            eq(connectorHeldCalls.state, 'queued'),
            or(isNull(connectorHeldCalls.runDeadline), lt(connectorHeldCalls.runDeadline, sql`now()`)),
          ),
        ),
        jobGoneOrOld,
      ),
    )
    .limit(SWEEP_BATCH);
  for (const { id, state } of stuck) {
    try {
      await settleStuckHeldCall(id, state as 'queued' | 'dispatched');
    } catch (error) {
      logger.warn('[approvals] stuck held call sweep failed', { executionId: id, error: String(error) });
    }
  }
  // A gate an old replica decided, denied or expired never touched its held row.
  const orphaned = await db
    .update(connectorHeldCalls)
    .set({ state: 'cancelled', inputEnc: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(connectorHeldCalls.state, 'held'),
        sql`EXISTS (SELECT 1 FROM kortix.connector_calls c
          WHERE c.execution_id = kortix.connector_held_calls.execution_id AND c.status <> 'pending_approval')`,
      ),
    )
    .returning({ id: connectorHeldCalls.executionId });
  const wiped = await db
    .update(connectorHeldCalls)
    .set({
      inputEnc: null,
      state: sql`CASE WHEN ${connectorHeldCalls.state} = 'held' THEN 'cancelled' ELSE ${connectorHeldCalls.state} END`,
      finishedAt: sql`CASE WHEN ${connectorHeldCalls.state} = 'held' THEN now() ELSE ${connectorHeldCalls.finishedAt} END`,
      updatedAt: sql`now()`,
    })
    .where(and(isNotNull(connectorHeldCalls.inputEnc), lt(connectorHeldCalls.createdAt, old)))
    .returning({ id: connectorHeldCalls.executionId });
  return stuck.length + orphaned.length + wiped.length;
}

registerJobHandler(HELD_CALL_QUEUE, (job) => runHeldCall(job.jobKey), HELD_RUN_VISIBILITY_MS);
