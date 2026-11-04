/**
 * Inbound Slack and Teams webhooks: claim, ack, work. Telegram and Email store
 * each event before the ack instead (integrations/event-inbox.ts).
 *
 * A webhook handler claims its event in `chat_event_dedup` so a provider retry
 * does not run it twice, then acks 200 and works on. If the work fails, the
 * claim must not outlive it: the provider's retry (Slack) would find
 * the claim held and drop the event. This module records every claim a handler
 * takes, in an async scope, and releases them all when the work fails.
 *
 * The ack waits up to `ACK_WAIT_MS` for the work. A fast failure answers 500, so
 * the provider retries; slow work answers 200 and finishes in the background.
 * Either way the work is registered with the shutdown drain (`shared/drain.ts`),
 * so a deploy waits for it instead of cutting it.
 *
 * Not covered: a crash (OOM, SIGKILL) while the work runs. The claim then holds
 * until it expires, and the event is lost.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { inArray } from 'drizzle-orm';
import { chatEventDedup } from '@kortix/db';
import { db } from '../shared/db';
import { setContextField } from '../lib/request-context';
import { logger } from '../lib/logger';
import { trackDetached } from '../shared/drain';
import { formatStageEntries, stageSnapshot } from '../lib/server-timing';
import { dbPoolWaitSuspected } from '../lib/request-log-level';

/** Slack drops a webhook that has not answered after 3 s; stay well under it. */
export const ACK_WAIT_MS = 2_000;

const claimScope = new AsyncLocalStorage<Set<string>>();

/** Call after a claim insert wins. A no-op outside `runWebhookWork`. */
export function recordClaim(eventId: string): void {
  claimScope.getStore()?.add(eventId);
}

async function releaseClaims(keys: ReadonlySet<string>): Promise<void> {
  if (keys.size === 0) return;
  try {
    await db.delete(chatEventDedup).where(inArray(chatEventDedup.eventId, [...keys]));
  } catch (error) {
    logger.error('[webhook-work] claim release failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

export type WebhookOutcome = 'done' | 'pending' | 'failed';

export async function runWebhookWork(
  label: string,
  work: () => Promise<void>,
  options: { ackWaitMs?: number; releaseOnFailure?: boolean } = {},
): Promise<WebhookOutcome> {
  const claims = new Set<string>();
  const startedAt = performance.now();
  let outcome: WebhookOutcome = 'pending';
  const ackWaitMs = options.ackWaitMs ?? ACK_WAIT_MS;
  // True once an ack wait ended with the work still running: only then does the
  // request line not carry the work's duration, so only then is it logged. A
  // fire-and-forget caller (`ackWaitMs: 0`, Teams) never waited, so its work
  // always outlives the response and would log a line per event: no line.
  let answeredEarly = false;
  const logDetached = (): void => {
    if (!answeredEarly) return;
    const serverTiming = formatStageEntries(stageSnapshot()).join(', ');
    logger.info(`[${label}] detached work ${outcome}`, {
      duration_ms: Math.round(performance.now() - startedAt),
      ...(serverTiming ? { server_timing: serverTiming } : {}),
      ...(dbPoolWaitSuspected(serverTiming) ? { db_pool_wait_suspected: true } : {}),
    });
  };
  const running = claimScope.run(claims, work).then(
    () => {
      outcome = 'done';
      logDetached();
    },
    async (error) => {
      outcome = 'failed';
      logger.error(`[${label}] handler failed`, { error: error instanceof Error ? error.message : String(error) });
      logDetached();
      if (options.releaseOnFailure !== false) await releaseClaims(claims);
    },
  );
  trackDetached(running);
  if (ackWaitMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ackWaitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'pending') {
      // The deadline, not the work, decided the response. Name it on the
      // request line (a CloudWatch-safe diagnostic, see getDiagnosticFields):
      // a slow-request investigation on an ack-first webhook route then tells
      // a designed ACK_WAIT_MS ack from a genuinely slow handler with one
      // grep instead of an inference over timestamps.
      setContextField('webhook_ack', 'deadline');
      answeredEarly = true;
    }
  }
  return outcome;
}
