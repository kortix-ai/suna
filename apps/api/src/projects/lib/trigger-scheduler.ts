import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../../lib/config';
import { db } from '../../shared/db';
import { runWorkerTick } from '../../shared/audit-scope';
import { isLeader } from '../../shared/leader-election';
import { claimDueScheduleSlots, claimTriggerExecutions, markTriggerExecutionDispatched, markTriggerExecutionFailed, markTriggerExecutionSkipped, markTriggerExecutionSucceeded, type TriggerExecutionRow } from '../trigger-execution-store';
import type { GitTriggerSpec } from '../triggers';
import { drainMonitorEvents } from './monitor-observer';
import { renderPromptTemplate } from './trigger-payload';
import { fireGitTrigger, markGitTriggerAttemptFailed, markGitTriggerFired } from './trigger-fire';
import { runProjectConnectorSweep } from './trigger-connector-sweep';
import { schedulerHealth, triggerFireTimeoutMs, triggerScheduleClaimLimit, triggerExecutionConcurrency, triggerSchedulerIntervalMs, connectorSweepIntervalMs, initialCatalogBackfillIncomplete, mapWithConcurrency, schedulerSweepIsStale, triggersPausedForProject, withTimeout, globalForProjectTriggers, type TriggerSchedulerTimer } from './trigger-scheduler-state';

export let triggerSchedulerTimer: TriggerSchedulerTimer | null = null;
export let triggerSweepRunning = false;
let triggerExecutionDrainRunning = false;

/**
 * Loads cataloged trigger projects and fires due cron triggers.
 *
 * Trigger configuration stays in git. The runtime table is the project catalog
 * and the last-fire state store.
 */

export let lastConnectorSweepAt = 0;

export async function runProjectTriggerSweep(now = new Date()): Promise<{
  projects: number;
  scanned: number;
  fired: number;
  queued: number;
  failed: number;
  skipped: number;
}> {
  if (triggerSweepRunning) {
    return {
      projects: 0,
      scanned: 0,
      fired: 0,
      queued: 0,
      failed: 0,
      skipped: 0,
    };
  }
  triggerSweepRunning = true;
  const startedMs = Date.now();
  schedulerHealth.lastSweepStartedAt = now.toISOString();
  const result = {
    projects: 0,
    scanned: 0,
    fired: 0,
    queued: 0,
    failed: 0,
    skipped: 0,
  };
  let status: 'completed' | 'failed' = 'completed';
  try {
    await runGitTriggerSweep(now, result);
    schedulerHealth.lastError = null;
    return result;
  } catch (err) {
    status = 'failed';
    schedulerHealth.lastError = err instanceof Error ? err.message : String(err);
    console.error('[project-triggers/git] sweep failed', err);
    return result;
  } finally {
    schedulerHealth.lastSweepCompletedAt = new Date().toISOString();
    schedulerHealth.lastSweepDurationMs = Date.now() - startedMs;
    schedulerHealth.lastResult = result;
    triggerSweepRunning = false;
    if (status === 'failed' || result.scanned > 0) {
      console.log('[project-triggers] schedule claim completed', {
        status,
        durationMs: schedulerHealth.lastSweepDurationMs,
        ...result,
        error: schedulerHealth.lastError,
      });
    }
  }
}

/**
 * Reconcile bounded, rotating batches of manifest projects.
 *
 * UI CRUD and `kortix ship` reconcile inline. The discovery batch catches raw
 * git pushes. The catalog batch refreshes known trigger and connector projects.
 */

export async function runGitTriggerSweep(
  now: Date,
  accumulator: {
    projects: number;
    scanned: number;
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  },
): Promise<void> {
  const claimedSlots = await claimDueScheduleSlots({
    now,
    limit: triggerScheduleClaimLimit(),
  });
  if (claimedSlots.length > 0) {
    const batchMaxClaimLagMs = Math.max(
      ...claimedSlots.map((slot) =>
        Math.max(0, now.getTime() - slot.execution.scheduledFor.getTime()),
      ),
    );
    schedulerHealth.lastClaimLagMs = batchMaxClaimLagMs;
    schedulerHealth.maxObservedClaimLagMs = Math.max(
      schedulerHealth.maxObservedClaimLagMs ?? 0,
      batchMaxClaimLagMs,
    );
  }
  accumulator.scanned += claimedSlots.length;
  accumulator.projects += new Set(claimedSlots.map((slot) => slot.execution.projectId)).size;
}

async function executeTriggerExecution(
  row: TriggerExecutionRow,
): Promise<'fired' | 'queued' | 'failed' | 'skipped'> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, row.projectId))
    .limit(1);
  if (!project || project.status !== 'active' || triggersPausedForProject(project.metadata)) {
    const reason = !project
      ? 'project not found'
      : project.status !== 'active'
        ? 'project is not active'
        : 'project triggers are paused';
    await markTriggerExecutionSkipped({
      row,
      skippedAt: new Date(),
      reason,
    });
    return 'skipped';
  }

  const spec = row.spec as unknown as GitTriggerSpec;
  const payload = row.payload as Record<string, unknown>;
  const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);
  const idempotencyKey = `trigger:cron:${row.projectId}:${row.slug}:${row.scheduleRevision}:${row.scheduledFor.toISOString()}`;
  try {
    await markTriggerExecutionDispatched({ row, dispatchedAt: new Date() });
    const result = await withTimeout(
      fireGitTrigger({
        spec,
        project,
        payload,
        renderedPrompt,
        source: 'cron',
        idempotencyKey,
      }),
      triggerFireTimeoutMs(),
      `execute scheduled trigger ${row.executionId}`,
    );
    const completedAt = new Date();
    return recordTriggerExecutionResult(row, result, completedAt);
  } catch (error) {
    const failedAt = new Date();
    const message = error instanceof Error ? error.message : String(error);
    const state = await markTriggerExecutionFailed({ row, failedAt, error: message });
    await markGitTriggerAttemptFailed(row.projectId, row.slug, failedAt, message).catch(() => {});
    return state === 'queued' ? 'queued' : 'failed';
  }
}

async function recordTriggerExecutionResult(
  row: TriggerExecutionRow,
  result: Awaited<ReturnType<typeof fireGitTrigger>>,
  completedAt: Date,
): Promise<'fired' | 'queued' | 'failed'> {
    if (result.status === 'fired' || result.status === 'queued') {
      // `queued` means two different things to `fireGitTrigger`. A reuse/keyed/
      // pinned fire that hands the prompt to an EXISTING session (`reason:
      // 'prompt queued for delivery'`) is a COMPLETE fire — the session exists
      // and the prompt is durably queued. Recording that as `last_status:
      // 'queued'` left a healthy fire indistinguishable from a create still
      // waiting on backpressure, so the reliability operator's
      // `QUEUED_OVER_15M` attention flagged every `session_mode: reuse`
      // trigger permanently. Only a create that is genuinely still pending
      // (no session yet) stays `queued`; the delivery handoff is `fired`, the
      // same status the webhook fire path records for the identical outcome.
      const runtimeStatus =
        result.status === 'queued' && result.reason === 'prompt queued for delivery'
          ? 'fired'
          : result.status;
      await Promise.all([
        markTriggerExecutionSucceeded({
          row,
          completedAt,
          sessionId: result.sessionId,
          commandId: result.commandId,
        }),
        markGitTriggerFired(row.projectId, row.slug, completedAt, runtimeStatus),
      ]);
      return result.status;
    }
    const error = result.error ?? result.reason ?? 'scheduled trigger execution failed';
    // A billing-gate rejection (wallet drained / no plan / no account) is
    // PERMANENT — a retry re-runs the same `createSession` →
    // `checkBillingAdmission` only to fail identically, so retrying five times
    // over ~30s only delays the terminal state. Mark it terminal on the first
    // failure so the trigger runtime row shows `failed` + the machine-readable
    // reason immediately.
    const terminal = result.errorCode === 'insufficient_credits'
      || result.errorCode === 'subscription_required'
      || result.errorCode === 'no_account'
      // The fire already paused the reminder; a retry cannot bring the session back.
      || result.errorCode === 'reminder_session_gone';
    const state = await markTriggerExecutionFailed({ row, failedAt: completedAt, error, terminal });
    await markGitTriggerAttemptFailed(row.projectId, row.slug, completedAt, error);
    return state === 'queued' ? 'queued' : 'failed';
}

export async function drainTriggerExecutionQueue(
  now = new Date(),
): Promise<{ fired: number; queued: number; failed: number; skipped: number }> {
  if (triggerExecutionDrainRunning) {
    return { fired: 0, queued: 0, failed: 0, skipped: 0 };
  }
  triggerExecutionDrainRunning = true;
  schedulerHealth.lastExecutionDrainStartedAt = now.toISOString();
  try {
    const rows = await claimTriggerExecutions({
      now,
      workerId: `trigger-execution:${process.pid}:${now.getTime()}`,
      limit: triggerScheduleClaimLimit(),
    });
    const outcomes = await mapWithConcurrency(rows, triggerExecutionConcurrency(), (row) =>
      executeTriggerExecution(row),
    );
    const result = { fired: 0, queued: 0, failed: 0, skipped: 0 };
    for (const outcome of outcomes) result[outcome] += 1;
    schedulerHealth.lastExecutionResult = result;
    schedulerHealth.lastExecutionError = null;
    return result;
  } catch (error) {
    schedulerHealth.lastExecutionError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    schedulerHealth.lastExecutionDrainCompletedAt = new Date().toISOString();
    triggerExecutionDrainRunning = false;
  }
}

export function startProjectTriggerScheduler(): void {
  if ((config as any).KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
  }
  const tickBody = () => {
    // Watchdog: if we're the leader but the sweep has stalled (started and never
    // completed within the stale window), make it LOUD. A silent dead scheduler
    // is what turned a single hung fire into an ~18h fleet-wide outage.
    if (schedulerSweepIsStale(isLeader())) {
      console.error(
        '[project-triggers] SCHEDULER STALLED — leader but last sweep has not completed',
        {
          lastSweepStartedAt: schedulerHealth.lastSweepStartedAt,
          lastSweepCompletedAt: schedulerHealth.lastSweepCompletedAt,
        },
      );
    }

    runProjectTriggerSweep()
      .then(() => drainTriggerExecutionQueue())
      .then((result) => {
        if (result.fired || result.queued || result.failed || result.skipped) {
          console.log('[project-triggers] execution drain completed', result);
        }
      })
      .catch((error) => {
        console.error('[project-triggers] scheduler tick failed:', error);
      });

    // Monitor events land in their own append-only log, so they drain beside
    // the execution queue rather than through it — one slow monitor fire must
    // not stall a due cron slot, and vice versa.
    drainMonitorEvents()
      .then((result) => {
        if (result.fired || result.failed || result.skipped) {
          console.log('[project-monitors] event drain completed', result);
        }
      })
      .catch((error) => {
        console.error('[project-monitors] event drain failed:', error);
      });

    // Connector reconcile backstop — slower cadence than the trigger sweep so
    // we don't re-read every manifest each tick. Catches out-of-band manifest
    // edits (raw git push / CLI) and heals any DB drift / retries error rows.
    if (Date.now() - lastConnectorSweepAt >= connectorSweepIntervalMs()) {
      lastConnectorSweepAt = Date.now();
      runProjectConnectorSweep()
        .then(() => {
          if (initialCatalogBackfillIncomplete(schedulerHealth)) {
            // On a new scheduler release, drain the bounded catalog batches
            // continuously instead of waiting two minutes between each batch.
            // Once both cursors complete a full cycle with no pending rows, the
            // normal connector cadence resumes. Individual project failures
            // retry on that bounded cadence; a permanently inaccessible repo
            // must not force an unbounded full-fleet reconciliation loop.
            lastConnectorSweepAt = 0;
          }
        })
        .catch((error) => {
          lastConnectorSweepAt = 0;
          console.error('[project-connectors] sweep failed:', error);
        });
    }
  };
  // Everything the tick starts (sweep, drains, connector reconcile) inherits
  // the worker context through AsyncLocalStorage.
  const tick = () => void runWorkerTick('trigger-scheduler', tickBody);
  tick();
  triggerSchedulerTimer = setInterval(tick, triggerSchedulerIntervalMs());
  globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = triggerSchedulerTimer;
}

export function stopProjectTriggerScheduler(): void {
  if (triggerSchedulerTimer) {
    clearInterval(triggerSchedulerTimer);
    triggerSchedulerTimer = null;
  }
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
    globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = null;
  }
}
