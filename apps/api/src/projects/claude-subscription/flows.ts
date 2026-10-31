/**
 * The Claude subscription login run in Kortix.
 *
 *   start    (any replica) runs `claude setup-token` here, records a flow row
 *            with the authorize URL, and keeps the process in this replica.
 *   complete (any replica) writes the pasted code to the flow row, then waits
 *            for the row to say `connected` or `failed`.
 *   owner    (the replica that started the flow) polls its row every 500 ms,
 *            feeds a written code to the process, stores the token and records
 *            the outcome. It also marks the row as alive, so a complete call
 *            fails fast when the owner stopped.
 *
 * A flow lives at most FLOW_TTL_MS. A member has one live flow: a new start
 * fails the older one, and its owner stops the process.
 */
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { claudeSubscriptionLoginFlows } from '@kortix/db';
import { config } from '../../config';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';
import { SetupTokenError, startSetupToken, type SetupTokenRun } from './setup-token';
import { pushClaudeLoginToSessions } from './delivery';
import { saveClaudeLogin } from '../../claude-subscription/store';

export const FLOW_TTL_MS = 10 * 60_000;
const OWNER_POLL_MS = 500;
/** An owner that has not polled for this long has stopped. */
const OWNER_STALE_MS = 15_000;
const COMPLETE_WAIT_MS = 45_000;
/** Login processes this replica runs at once. */
const MAX_LIVE_RUNS = 16;

type FlowStatus = 'starting' | 'awaiting_code' | 'exchanging' | 'connected' | 'failed';

export class ClaudeLoginFlowError extends Error {
  constructor(
    readonly code: 'claude_unavailable' | 'start_timeout' | 'busy' | 'expired' | 'invalid_code' | 'login_failed' | 'not_found',
    message: string,
    readonly status: 400 | 404 | 409 | 410 | 429 | 502 | 503 = 502,
  ) {
    super(message);
    this.name = 'ClaudeLoginFlowError';
  }
}

// replica-local: the processes this replica owns; the flow rows are the shared state.
const liveRuns = new Map<string, SetupTokenRun>();

export interface StartedClaudeLogin {
  flowId: string;
  authorizeUrl: string;
  expiresAt: string;
}

export async function startClaudeLogin(input: { accountId: string; userId: string }): Promise<StartedClaudeLogin> {
  if (liveRuns.size >= MAX_LIVE_RUNS) {
    throw new ClaudeLoginFlowError('busy', 'Too many Claude sign-ins are running. Try again in a minute.', 429);
  }
  // One live flow per member: an older one fails, and its owner stops it.
  await db
    .update(claudeSubscriptionLoginFlows)
    .set({ status: 'failed', error: 'replaced', codeEnc: null, updatedAt: new Date() })
    .where(
      and(
        eq(claudeSubscriptionLoginFlows.accountId, input.accountId),
        eq(claudeSubscriptionLoginFlows.userId, input.userId),
        inArray(claudeSubscriptionLoginFlows.status, ['starting', 'awaiting_code', 'exchanging']),
      ),
    );
  // Rows of this member older than a day carry no use.
  await db
    .delete(claudeSubscriptionLoginFlows)
    .where(
      and(
        eq(claudeSubscriptionLoginFlows.accountId, input.accountId),
        eq(claudeSubscriptionLoginFlows.userId, input.userId),
        lt(claudeSubscriptionLoginFlows.createdAt, new Date(Date.now() - 24 * 3600_000)),
      ),
    );

  let run: SetupTokenRun;
  try {
    run = await startSetupToken({ claudePath: config.CLAUDE_CODE_PATH });
  } catch (err) {
    if (err instanceof SetupTokenError) {
      const status = err.code === 'claude_unavailable' ? 503 : 502;
      throw new ClaudeLoginFlowError(err.code === 'claude_unavailable' ? 'claude_unavailable' : 'start_timeout', err.message, status);
    }
    throw err;
  }
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS);
  let flowId: string;
  try {
    const [row] = await db
      .insert(claudeSubscriptionLoginFlows)
      .values({
        accountId: input.accountId,
        userId: input.userId,
        status: 'awaiting_code',
        authorizeUrl: run.authorizeUrl,
        expiresAt,
      })
      .returning({ flowId: claudeSubscriptionLoginFlows.flowId });
    flowId = row!.flowId;
  } catch (err) {
    run.stop();
    throw err;
  }
  liveRuns.set(flowId, run);
  void ownFlow(flowId, input.accountId, input.userId, run, expiresAt.getTime());
  return { flowId, authorizeUrl: run.authorizeUrl, expiresAt: expiresAt.toISOString() };
}

async function setFlow(flowId: string, values: Partial<typeof claudeSubscriptionLoginFlows.$inferInsert>): Promise<void> {
  await db
    .update(claudeSubscriptionLoginFlows)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(claudeSubscriptionLoginFlows.flowId, flowId));
}

/** The owner loop of one flow. Never throws: every exit records an outcome. */
async function ownFlow(flowId: string, accountId: string, userId: string, run: SetupTokenRun, expiresAtMs: number): Promise<void> {
  try {
    while (true) {
      await Bun.sleep(OWNER_POLL_MS);
      const [row] = await db
        .select({ status: claudeSubscriptionLoginFlows.status, codeEnc: claudeSubscriptionLoginFlows.codeEnc })
        .from(claudeSubscriptionLoginFlows)
        .where(eq(claudeSubscriptionLoginFlows.flowId, flowId))
        .limit(1);
      if (!row || row.status === 'failed' || row.status === 'connected') return;
      if (Date.now() > expiresAtMs) {
        await setFlow(flowId, { status: 'failed', error: 'expired', codeEnc: null });
        return;
      }
      if (!row.codeEnc) {
        await setFlow(flowId, { ownerSeenAt: new Date() });
        continue;
      }
      // Clear the code in the same write that claims it.
      await setFlow(flowId, { status: 'exchanging', codeEnc: null, ownerSeenAt: new Date() });
      let code: string;
      try {
        code = decryptAccountSecret(accountId, row.codeEnc);
      } catch {
        await setFlow(flowId, { status: 'failed', error: 'login_failed' });
        return;
      }
      try {
        const token = await run.submit(code);
        await saveClaudeLogin(accountId, userId, token, 'setup_token');
        await setFlow(flowId, { status: 'connected', error: null });
        void onClaudeLoginChanged(accountId, userId);
      } catch (err) {
        const reason = err instanceof SetupTokenError ? err.code : 'login_failed';
        await setFlow(flowId, { status: 'failed', error: reason });
        if (!(err instanceof SetupTokenError)) {
          logger.warn('[claude-subscription] storing a Claude login failed', { flowId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }
  } catch (err) {
    logger.warn('[claude-subscription] a login flow stopped', { flowId, error: err instanceof Error ? err.message : String(err) });
    await setFlow(flowId, { status: 'failed', error: 'login_failed', codeEnc: null }).catch(() => undefined);
  } finally {
    run.stop();
    liveRuns.delete(flowId);
  }
}

const FAILURES: Record<string, ClaudeLoginFlowError> = {
  expired: new ClaudeLoginFlowError('expired', 'This Claude sign-in expired. Start it again.', 410),
  restarted: new ClaudeLoginFlowError('expired', 'Kortix restarted during your sign-in. Sign in with Claude again.', 410),
  replaced: new ClaudeLoginFlowError('expired', 'A newer Claude sign-in replaced this one.', 410),
  invalid_code: new ClaudeLoginFlowError('invalid_code', 'Claude did not accept that code. Sign in with Claude again and paste the new code.', 400),
};

function failure(error: string | null): ClaudeLoginFlowError {
  return FAILURES[error ?? ''] ?? new ClaudeLoginFlowError('login_failed', 'Claude Code did not finish the sign-in. Start it again.', 502);
}

/** Hand the pasted code to the flow's owner and wait for the outcome. */
export async function completeClaudeLogin(input: { accountId: string; userId: string; flowId: string; code: string }): Promise<void> {
  const code = input.code.trim();
  if (!code || code.length > 2048) throw new ClaudeLoginFlowError('invalid_code', 'Paste the code claude.com showed you.', 400);
  const [row] = await db
    .select({ status: claudeSubscriptionLoginFlows.status, error: claudeSubscriptionLoginFlows.error, expiresAt: claudeSubscriptionLoginFlows.expiresAt, ownerSeenAt: claudeSubscriptionLoginFlows.ownerSeenAt })
    .from(claudeSubscriptionLoginFlows)
    .where(
      and(
        eq(claudeSubscriptionLoginFlows.flowId, input.flowId),
        eq(claudeSubscriptionLoginFlows.accountId, input.accountId),
        eq(claudeSubscriptionLoginFlows.userId, input.userId),
      ),
    )
    .limit(1);
  if (!row) throw new ClaudeLoginFlowError('not_found', 'No such Claude sign-in', 404);
  if (row.status === 'connected') return;
  if (row.status === 'failed') throw failure(row.error);
  if (row.expiresAt.getTime() < Date.now()) throw FAILURES.expired!;
  if (Date.now() - row.ownerSeenAt.getTime() > OWNER_STALE_MS) {
    throw FAILURES.restarted!;
  }
  if (row.status !== 'awaiting_code') throw new ClaudeLoginFlowError('busy', 'This sign-in is already checking a code', 409);
  const written = await db
    .update(claudeSubscriptionLoginFlows)
    .set({ codeEnc: encryptAccountSecret(input.accountId, code), updatedAt: new Date() })
    .where(and(eq(claudeSubscriptionLoginFlows.flowId, input.flowId), eq(claudeSubscriptionLoginFlows.status, 'awaiting_code')))
    .returning({ flowId: claudeSubscriptionLoginFlows.flowId });
  if (written.length === 0) throw new ClaudeLoginFlowError('busy', 'This sign-in is already checking a code', 409);

  const deadline = Date.now() + COMPLETE_WAIT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(OWNER_POLL_MS);
    const [next] = await db
      .select({ status: claudeSubscriptionLoginFlows.status, error: claudeSubscriptionLoginFlows.error, ownerSeenAt: claudeSubscriptionLoginFlows.ownerSeenAt })
      .from(claudeSubscriptionLoginFlows)
      .where(eq(claudeSubscriptionLoginFlows.flowId, input.flowId))
      .limit(1);
    if (!next) throw new ClaudeLoginFlowError('not_found', 'No such Claude sign-in', 404);
    const status = next.status as FlowStatus;
    if (status === 'connected') return;
    if (status === 'failed') throw failure(next.error);
    if (status === 'awaiting_code' && Date.now() - next.ownerSeenAt.getTime() > OWNER_STALE_MS) {
      await setFlow(input.flowId, { status: 'failed', error: 'restarted', codeEnc: null });
      throw FAILURES.restarted!;
    }
  }
  throw new ClaudeLoginFlowError('login_failed', 'Claude Code did not answer in time. Start the sign-in again.', 502);
}

/**
 * Shutdown (bootstrap.ts): the `claude` processes of this task end with it. Wait
 * up to `budgetMs` for the sign-ins it owns to finish (a code pasted meanwhile
 * reaches this task through the flow row from any replica), then fail the rest
 * as `restarted`, so the member reads why at once and signs in again.
 */
export async function drainClaudeLogins(budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (liveRuns.size > 0 && Date.now() < deadline) await Bun.sleep(OWNER_POLL_MS);
  const left = [...liveRuns.keys()];
  if (left.length === 0) return;
  await db
    .update(claudeSubscriptionLoginFlows)
    .set({ status: 'failed', error: 'restarted', codeEnc: null, updatedAt: new Date() })
    .where(and(inArray(claudeSubscriptionLoginFlows.flowId, left), ne(claudeSubscriptionLoginFlows.status, 'connected')));
  for (const flowId of left) liveRuns.get(flowId)?.stop();
}

/** Fail every live flow of the member: their owners stop the processes. */
export async function cancelClaudeLogins(accountId: string, userId: string): Promise<void> {
  await db
    .update(claudeSubscriptionLoginFlows)
    .set({ status: 'failed', error: 'replaced', codeEnc: null, updatedAt: new Date() })
    .where(
      and(
        eq(claudeSubscriptionLoginFlows.accountId, accountId),
        eq(claudeSubscriptionLoginFlows.userId, userId),
        ne(claudeSubscriptionLoginFlows.status, 'connected'),
        ne(claudeSubscriptionLoginFlows.status, 'failed'),
      ),
    );
}

/** Push a changed login to the member's running sessions. Best effort: never throws. */
export async function onClaudeLoginChanged(accountId: string, userId: string): Promise<void> {
  try {
    await pushClaudeLoginToSessions(accountId, userId);
  } catch (err) {
    logger.warn('[claude-subscription] pushing a changed login to running sessions failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
