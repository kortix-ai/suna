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
// Every project sends them (the notification center graduated, 2026-11-06).
// Email is opt-in for the alerts that went out only with the center on, a
// failure streak and a run-cap day: they pass `emailDefault: false`. The ones
// that always went out, a health streak (silence, crash) and an auto-pause,
// keep the kind's email default (2026-11-02: one project's triggers failed
// ~1,250 times a day for a month, unseen).
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { projectTriggerRuntime } from '@kortix/db';
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { logger } from '../../lib/logger';
import { clip, INBOX_BODY_MAX_CHARS } from '../../notifications/inbox-store';
import { deliver, liveNotifierDeps, type NotifierDeps } from '../../notifications/notifier';
import { db } from '../../shared/db';
import { resolveTriggerWatchers } from './trigger-watchers';
import { projectsView } from '../../workspaces/rows';

/**
 * 'fire' and 'run' as below; 'silence': an app trigger heard no App event
 * within its `expect_event_within` (app-trigger-silence.ts). The App's next
 * event clears it (app-events.ts). 'crash': the always-on App the trigger
 * names stopped 3 times in an hour and keep-alive stopped restarting it
 * (app-health-alerts.ts); the next pass that finds it running clears it.
 */
export type TriggerAlertSource = 'fire' | 'run' | 'silence' | 'crash';

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

/** The alert's subject: the trigger's name. An unnamed reminder (a loop) is titled "Loop": its id says nothing. */
function alertTitle(slug: string, row: { name: string | null; reminder: boolean }): string {
  const name = row.name?.trim();
  if (row.reminder && (!name || name === slug)) return 'Loop';
  return name || slug;
}

function runtimeRow(input: TriggerAlertInput) {
  return and(eq(projectTriggerRuntime.projectId, input.projectId), eq(projectTriggerRuntime.slug, input.slug));
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Start a failure streak and alert the watchers. True when this call started it. */
export async function raiseTriggerAlert(input: TriggerAlertInput & { error: string }): Promise<boolean> {
  try {
    const [row] = await db
      .update(projectTriggerRuntime)
      .set({ alertFailingSince: sql`now()`, alertSource: input.source })
      .where(and(runtimeRow(input), isNull(projectTriggerRuntime.alertFailingSince)))
      .returning({ since: projectTriggerRuntime.alertFailingSince, name: triggerName, reminder: isReminder });
    if (!row?.since) return false;
    announce('automation_failed', input, alertTitle(input.slug, row), `automation:${input.projectId}:${input.slug}:${row.since.getTime()}`, input.error, { emailDefault: false });
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
    announce('automation_recovered', input, alertTitle(input.slug, row), `recovered:${input.projectId}:${input.slug}:${row.since.getTime()}`, '', {});
    return true;
  } catch (err) {
    logger.warn('[trigger-alerts] clear failed', { projectId: input.projectId, slug: input.slug, error: reason(err) });
    return false;
  }
}

/**
 * An app trigger heard no App event within its `expect_event_within`: start a
 * silence streak and tell the watchers once, by email too unless they turned
 * it off: a watcher App that stopped posting is invisible otherwise. True
 * when this call started it; a streak of another source already open wins
 * (one alert at a time).
 */
export async function raiseTriggerSilenceAlert(input: { projectId: string; slug: string; accountId?: string | null; error: string }): Promise<boolean> {
  return raiseTriggerHealthAlert({ ...input, source: 'silence' });
}

/**
 * A health streak (`silence` or `crash`) on one trigger, announced once with
 * the kind's email default. True when this call started it; a streak of
 * another source already open wins (one alert at a time).
 */
export async function raiseTriggerHealthAlert(input: { projectId: string; slug: string; accountId?: string | null; error: string; source: 'silence' | 'crash' }): Promise<boolean> {
  const alertInput: TriggerAlertInput = { projectId: input.projectId, slug: input.slug, source: input.source, accountId: input.accountId };
  try {
    const [row] = await db
      .update(projectTriggerRuntime)
      .set({ alertFailingSince: sql`now()`, alertSource: input.source })
      .where(and(runtimeRow(alertInput), isNull(projectTriggerRuntime.alertFailingSince)))
      .returning({ since: projectTriggerRuntime.alertFailingSince, name: triggerName, reminder: isReminder });
    if (!row?.since) return false;
    announce('automation_failed', alertInput, alertTitle(input.slug, row), `${input.source}:${input.projectId}:${input.slug}:${row.since.getTime()}`, input.error, {});
    return true;
  } catch (err) {
    logger.warn('[trigger-alerts] health raise failed', { projectId: input.projectId, slug: input.slug, source: input.source, error: reason(err) });
    return false;
  }
}

// replica-local: the `throttled:<project>:<slug>:<UTC day>` alerts this
// process already started. The inbox dedupe key makes the alert once-only
// across replicas; this only spares a busy trigger the watcher read per fire.
const throttleAlerted = new Set<string>();
const THROTTLE_ALERTED_MAX = 10_000;

/**
 * A trigger past a run cap (KRTX-1721) tells its watchers once per UTC day.
 * Not a failure streak: the trigger runs again when its window has room, so
 * the edge is the day (the inbox dedupe key), not `alert_failing_since`, and
 * no `automation_recovered` follows. Never throws; delivery runs in the
 * background.
 */
export function alertTriggerThrottled(input: { projectId: string; accountId?: string | null; slug: string; reason: string; now: Date }): void {
  const dedupeKey = `throttled:${input.projectId}:${input.slug}:${input.now.toISOString().slice(0, 10)}`;
  if (throttleAlerted.has(dedupeKey)) return;
  if (throttleAlerted.size >= THROTTLE_ALERTED_MAX) throttleAlerted.clear();
  throttleAlerted.add(dedupeKey);
  const alertInput: TriggerAlertInput = { projectId: input.projectId, slug: input.slug, source: 'fire', accountId: input.accountId };
  const run = (async () => {
    const [row] = await db
      .select({ name: triggerName, reminder: isReminder })
      .from(projectTriggerRuntime)
      .where(runtimeRow(alertInput))
      .limit(1);
    announce('automation_failed', alertInput, alertTitle(input.slug, row ?? { name: null, reminder: false }), dedupeKey, input.reason, { emailDefault: false });
  })().catch((err) => {
    logger.warn('[trigger-alerts] throttle alert failed', { projectId: input.projectId, slug: input.slug, error: reason(err) });
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/**
 * A trigger that paused itself (a sustained run-limit breach, KRTX-1721, or
 * 24 hours of runs only its owner can fix, trigger-failure-pause.ts) tells its
 * watchers once per pause, with the kind's email default. The
 * caller calls this only from the update that set `auto_paused_at`, and the
 * inbox dedupe key carries that time, so a later pause after a resume is a
 * new alert. Never throws.
 */
export function alertTriggerAutoPaused(input: { projectId: string; accountId?: string | null; slug: string; reason: string; pausedAt: Date }): void {
  const alertInput: TriggerAlertInput = { projectId: input.projectId, slug: input.slug, source: 'fire', accountId: input.accountId };
  const dedupeKey = `auto_paused:${input.projectId}:${input.slug}:${input.pausedAt.getTime()}`;
  const run = (async () => {
    const [row] = await db
      .select({ name: triggerName, reminder: isReminder })
      .from(projectTriggerRuntime)
      .where(runtimeRow(alertInput))
      .limit(1);
    announce('automation_failed', alertInput, alertTitle(input.slug, row ?? { name: null, reminder: false }), dedupeKey, input.reason, {});
  })().catch((err) => {
    logger.warn('[trigger-alerts] auto-pause alert failed', { projectId: input.projectId, slug: input.slug, error: reason(err) });
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** `email.emailDefault`: the delivery's email default (`DeliverInput.emailDefault`); absent, the kind's. */
function announce(
  kind: NotificationKindName,
  input: TriggerAlertInput,
  title: string,
  dedupeKey: string,
  body: string,
  email: { emailDefault?: boolean },
): void {
  const run = (async () => {
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
        emailDefault: email.emailDefault,
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
    .select({ accountId: projectsView.accountId })
    .from(projectsView)
    .where(eq(projectsView.projectId, projectId))
    .limit(1);
  return row?.accountId ?? null;
}
