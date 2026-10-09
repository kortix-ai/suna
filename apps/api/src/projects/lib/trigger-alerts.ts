// Automation alerts (KRTX-1742): a trigger that starts failing tells its
// watchers once, and tells them once more when it works again.
//
// `project_trigger_runtime.alert_failing_since` is the edge. The first
// terminal failure sets it with one `UPDATE ... WHERE alert_failing_since IS
// NULL`, so failures on several replicas at once raise exactly once. Only the
// recovery that matches `alert_source` clears it:
//   - 'fire': a fire that could not start (a dead-lettered cron or reminder
//     slot or prompt, a failed webhook, manual, event or monitor fire). The
//     next good fire clears it.
//   - 'run': a run that ended with an error. The next finished run clears it.
//
// The edge write is awaited. The fan-out (watchers, inbox rows, push, email)
// runs in the background, so a scheduler tick or a route never waits on it.
// Nothing here throws.
//
// Alerts are behind the project's `notification_center` flag. Off, a raise
// writes no edge, so a project that turns the flag on starts clean, and a
// clear ends an edge left from an on period without a word.
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { projectTriggerRuntime, projects } from '@kortix/db';
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { logger } from '../../lib/logger';
import { clip, INBOX_BODY_MAX_CHARS } from '../../notifications/inbox-store';
import { projectNotificationsEnabled } from '../../notifications/enabled';
import { deliver, liveNotifierDeps, type NotifierDeps } from '../../notifications/notifier';
import { db } from '../../shared/db';
import { resolveTriggerWatchers } from './trigger-watchers';

export type TriggerAlertSource = 'fire' | 'run';

export interface TriggerAlertInput {
  projectId: string;
  slug: string;
  source: TriggerAlertSource;
  /** Read from the project when absent. */
  accountId?: string | null;
}

// replica-local: the deliveries this process started and has not finished.
// `settleTriggerAlerts` waits for them; nothing else reads the set.
const inFlight = new Set<Promise<void>>();
let notifierOverrides: Partial<NotifierDeps> | null = null;

/** Capture the alert senders in a test; `null` restores the live senders. */
export function setTriggerAlertNotifierForTest(overrides: Partial<NotifierDeps> | null): void {
  notifierOverrides = overrides;
}

/** Wait until every alert this process started is delivered. */
export async function settleTriggerAlerts(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

const triggerName = sql<string | null>`${projectTriggerRuntime.scheduleSpec} ->> 'name'`;
const isReminder = sql<boolean>`${projectTriggerRuntime.scheduleSpec} ->> 'reminder' is not null`;

/** The alert's subject: the trigger's name. An unnamed reminder is named after its id, which says nothing. */
function alertTitle(slug: string, row: { name: string | null; reminder: boolean }): string {
  const name = row.name?.trim();
  if (row.reminder && (!name || name === slug)) return 'Reminder';
  return name || slug;
}

function runtimeRow(input: TriggerAlertInput) {
  return and(eq(projectTriggerRuntime.projectId, input.projectId), eq(projectTriggerRuntime.slug, input.slug));
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start a failure streak and alert the watchers. True when this call started
 * it. `notificationCenter`: the project's flag when the caller already read
 * it; absent, one primary-key read.
 */
export async function raiseTriggerAlert(
  input: TriggerAlertInput & { error: string; notificationCenter?: boolean },
): Promise<boolean> {
  try {
    if (!(input.notificationCenter ?? (await projectNotificationsEnabled(input.projectId)))) return false;
    const [row] = await db
      .update(projectTriggerRuntime)
      .set({ alertFailingSince: sql`now()`, alertSource: input.source })
      .where(and(runtimeRow(input), isNull(projectTriggerRuntime.alertFailingSince)))
      .returning({ since: projectTriggerRuntime.alertFailingSince, name: triggerName, reminder: isReminder });
    if (!row?.since) return false;
    announce('automation_failed', input, alertTitle(input.slug, row), `automation:${input.projectId}:${input.slug}:${row.since.getTime()}`, input.error, true);
    return true;
  } catch (err) {
    logger.warn('[trigger-alerts] raise failed', { projectId: input.projectId, slug: input.slug, error: reason(err) });
    return false;
  }
}

/** End a failure streak this source started and tell the watchers. True when this call ended it. */
export async function clearTriggerAlert(input: TriggerAlertInput): Promise<boolean> {
  try {
    // The self-join returns the streak start the UPDATE erases: it keys the
    // recovered row, so a repeat of this recovery writes nothing.
    const previous = alias(projectTriggerRuntime, 'previous');
    const [row] = await db
      .update(projectTriggerRuntime)
      .set({ alertFailingSince: null, alertSource: null })
      .from(previous)
      .where(and(
        runtimeRow(input),
        eq(projectTriggerRuntime.alertSource, input.source),
        isNotNull(projectTriggerRuntime.alertFailingSince),
        eq(previous.projectId, projectTriggerRuntime.projectId),
        eq(previous.slug, projectTriggerRuntime.slug),
      ))
      .returning({ since: previous.alertFailingSince, name: triggerName, reminder: isReminder });
    if (!row?.since) return false;
    announce('automation_recovered', input, alertTitle(input.slug, row), `recovered:${input.projectId}:${input.slug}:${row.since.getTime()}`, '', false);
    return true;
  } catch (err) {
    logger.warn('[trigger-alerts] clear failed', { projectId: input.projectId, slug: input.slug, error: reason(err) });
    return false;
  }
}

/** `flagChecked`: the caller already read the flag as on (a raise). */
function announce(
  kind: NotificationKindName,
  input: TriggerAlertInput,
  title: string,
  dedupeKey: string,
  body: string,
  flagChecked: boolean,
): void {
  const run = (async () => {
    if (!flagChecked && !(await projectNotificationsEnabled(input.projectId))) return;
    const accountId = input.accountId ?? (await accountOf(input.projectId));
    if (!accountId) return;
    const recipients = await resolveTriggerWatchers({ accountId, projectId: input.projectId, slug: input.slug });
    await deliver(
      {
        kind,
        accountId,
        projectId: input.projectId,
        triggerSlug: input.slug,
        title,
        body: clip(body, INBOX_BODY_MAX_CHARS),
        dedupeKey,
        recipients,
      },
      liveNotifierDeps(notifierOverrides ?? {}),
    );
  })().catch((err) => {
    logger.warn('[trigger-alerts] alert delivery failed', { kind, projectId: input.projectId, slug: input.slug, error: reason(err) });
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/**
 * The trigger whose fire a lifecycle command carried, or null. The drain uses
 * it on both edges: a dead letter starts a streak, a queued create that
 * reached its session ends one.
 */
export function commandTriggerSlug(row: { commandType: string; source: string; payload: unknown }): string | null {
  const payload = (row.payload ?? {}) as { triggerSlug?: unknown; metadata?: { trigger_kind?: unknown; trigger_slug?: unknown } };
  if (row.commandType === 'continue_session') {
    return typeof payload.triggerSlug === 'string' ? payload.triggerSlug : null;
  }
  if (row.commandType !== 'create_session' || !row.source.startsWith('trigger:')) return null;
  const slug = payload.metadata?.trigger_slug;
  return payload.metadata?.trigger_kind === 'git' && typeof slug === 'string' && slug ? slug : null;
}

async function accountOf(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return row?.accountId ?? null;
}
