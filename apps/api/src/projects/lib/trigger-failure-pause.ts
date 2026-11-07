/**
 * A trigger that cannot run pauses itself.
 *
 * Prod, 2026-11-02: one free project had 22 cron triggers pinned to models the
 * account could not use. Every fire was refused ("Model … is not available
 * for this account"), about 1,250 times a day for a month, and nothing
 * stopped them. The project had no notification center then, so nobody was
 * told.
 *
 * The rule: when every run of a trigger for at least 24 hours failed with a
 * refusal only its owner can fix (the model, the plan, the manifest), and at
 * least 3 runs failed in a row, the trigger pauses itself
 * (`project_trigger_runtime.auto_paused_at`, the run-cap pause, KRTX-1721)
 * and its watchers hear once. Resuming (`PATCH enabled: true`)
 * starts a new 24 hours.
 *
 * Deliberately NOT a reason to pause:
 * - credits: a top-up must bring the trigger back without a person resuming it;
 * - any platform fault (a git clone timeout, a box that never came up): the
 *   platform recovers, and the owner must not have to resume every trigger.
 *
 * A failure is matched on its text, as `deadLetterCause` does: executions
 * keep only the message. An unmatched message never pauses — the safe
 * direction.
 */
import { projectTriggerExecutions as runs } from '@kortix/db';
import { and, desc, eq, gt, lte, notInArray, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { alertTriggerAutoPaused } from './trigger-alerts';
import { autoPauseTrigger, readTriggerAutoPause } from './trigger-run-caps';

/** The refusals only the trigger's owner can fix. */
const OWNER_FIXABLE_SOURCES = [
  // INVALID_SESSION_MODEL: 'Model "codex/gpt-6.1-sol" is not available for this account'
  'is not available for this account',
  // no_usable_model: 'No usable model for this account. Connect a provider key …'
  'no usable model for this account',
  // The gateway's plan_upgrade_required: '"deepseek-v4.1-flash" requires a paid plan.'
  'requires a paid plan',
  // The manifest: 'workspace mode "read" requires restricted workspace artifacts'
  'workspace mode ".*" requires',
];
const OWNER_FIXABLE = new RegExp(OWNER_FIXABLE_SOURCES.join('|'), 'i');
const OWNER_FIXABLE_SQL = OWNER_FIXABLE_SOURCES.join('|');

/** Every run failed for this long before the trigger pauses. */
export const FAILING_PAUSE_AFTER_MS = 24 * 60 * 60_000;
/** And at least this many runs failed in a row. */
export const FAILING_PAUSE_MIN_RUNS = 3;
/** History older than this is not read. */
const LOOKBACK_MS = 45 * 24 * 60 * 60_000;

/** A failure only the trigger's owner can fix. */
export function isOwnerFixableTriggerFailure(error: string | null | undefined): boolean {
  return OWNER_FIXABLE.test(error ?? '');
}

/** The message inside a provider's JSON error body, else the first line; at most 300 characters. */
export function failingPauseDetail(error: string): string {
  const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(error)?.[1];
  const text = quoted ? quoted.replace(/\\(.)/g, '$1') : error.split('\n')[0]!;
  return text.trim().slice(0, 300);
}

export function failingPauseReason(error: string): string {
  return `auto-paused: every run failed for 24 hours: ${failingPauseDetail(error)}`;
}

/**
 * A run of the trigger that failed with an owner-fixable refusal: the fire was
 * refused, or the fire reached a session and its run failed.
 */
const ownerFixableFailure = sql<boolean>`(
  (${runs.status} in ('dead_lettered', 'failed') and coalesce(${runs.lastError}, '') ~* ${OWNER_FIXABLE_SQL})
  or (${runs.runStatus} = 'failed' and coalesce(${runs.runError}, '') ~* ${OWNER_FIXABLE_SQL})
)`;

/**
 * After a failed fire or run: pause the trigger when the rule above holds.
 * True only for the call that paused it. Never throws.
 */
export async function pauseTriggerIfAlwaysFailing(input: {
  projectId: string;
  accountId?: string | null;
  slug: string;
  error: string;
  now?: Date;
}): Promise<boolean> {
  if (!isOwnerFixableTriggerFailure(input.error)) return false;
  const now = input.now ?? new Date();
  try {
    const { pausedReason, resumedAt } = await readTriggerAutoPause(input.projectId, input.slug);
    if (pausedReason) return false;
    const lookback = new Date(now.getTime() - LOOKBACK_MS);
    const since = resumedAt && resumedAt > lookback ? resumedAt : lookback;
    const dayAgo = new Date(now.getTime() - FAILING_PAUSE_AFTER_MS);
    // Runs with an outcome: not waiting, not running, not skipped.
    const ended = and(
      eq(runs.projectId, input.projectId),
      eq(runs.slug, input.slug),
      gt(runs.createdAt, since),
      notInArray(runs.status, ['queued', 'running', 'skipped']),
      sql`coalesce(${runs.runStatus}, '') <> 'running'`,
    );

    // The last runs all failed this way.
    const last = await db
      .select({ failed: ownerFixableFailure })
      .from(runs)
      .where(ended)
      .orderBy(desc(runs.createdAt))
      .limit(FAILING_PAUSE_MIN_RUNS);
    if (last.length < FAILING_PAUSE_MIN_RUNS || !last.every((run) => run.failed)) return false;

    // The newest run at least 24 hours old failed this way too…
    const [boundary] = await db
      .select({ failed: ownerFixableFailure })
      .from(runs)
      .where(and(ended, lte(runs.createdAt, dayAgo)))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    if (!boundary?.failed) return false;

    // …and no run since then ended any other way.
    const [other] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(ended, gt(runs.createdAt, dayAgo), sql`not ${ownerFixableFailure}`));
    if (Number(other?.n ?? 0) > 0) return false;

    const reason = failingPauseReason(input.error);
    if (!(await autoPauseTrigger(input.projectId, input.slug, reason, now))) return false;
    logger.warn('[trigger-failure-pause] trigger auto-paused: every run failed for 24 hours', {
      project_id: input.projectId,
      slug: input.slug,
      reason,
    });
    alertTriggerAutoPaused({ projectId: input.projectId, accountId: input.accountId, slug: input.slug, reason, pausedAt: now });
    return true;
  } catch (err) {
    logger.warn('[trigger-failure-pause] check failed', {
      project_id: input.projectId,
      slug: input.slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
