/**
 * Session reminders: a scheduled prompt into ONE existing session.
 *
 * A reminder is a `project_trigger_runtime` row whose `schedule_spec.reminder` is set.
 * It never appears in kortix.yaml: an agent or a person creates it with one API
 * call, and the trigger scheduler claims and fires it like any cron row. A fire
 * queues the reminder prompt into the reminder's session. It never creates a session;
 * when the session is gone, the fire turns the reminder off (`lib/trigger-fire.ts`).
 *
 * Reminder ids are `reminder.<hex>`. The manifest slug pattern has no `.`, so a
 * kortix.yaml trigger can never collide with a reminder on the table's
 * (project_id, slug) key.
 */
import { randomBytes } from 'node:crypto';
import { projectTriggerRuntime } from '@kortix/db';
import { reminderPromptText as sharedReminderPromptText } from '@kortix/shared';
import { formatDurationSeconds, parseDurationSeconds } from '@kortix/manifest-schema';
import { Cron } from 'croner';
import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  nextTriggerScheduleSlot,
  triggerScheduleRevision,
  validateTriggerCron,
  validateTriggerTimezone,
} from '../trigger-schedule';
import type { GitTriggerSpec } from '../triggers';

/** A recurring reminder fires at most once per 5 minutes. Each fire is a model turn. */
export const REMINDER_MIN_INTERVAL_SECONDS = 300;
/** Active (scheduled) reminders one session may hold. */
export const REMINDER_MAX_ACTIVE_PER_SESSION = 20;
/** Active reminders one project may hold, across all its sessions. */
export const REMINDER_MAX_ACTIVE_PER_PROJECT = 200;
/** No first fire, `at`, or `every` beyond a year: a larger value overflows `Date` (HTTP 500). */
const REMINDER_MAX_HORIZON_SECONDS = 366 * 86400;
const HORIZON_LIMIT = `must be at most ${formatDurationSeconds(REMINDER_MAX_HORIZON_SECONDS)}`;
export const REMINDER_PROMPT_MAX_LENGTH = 10_000;
const REMINDER_NAME_MAX_LENGTH = 120;

export interface ReminderDraft {
  prompt: string;
  name: string | null;
  everySeconds: number | null;
  cron: string | null;
  timezone: string;
  /** The first fire. For a one-shot reminder it is also the only fire. */
  firstFireAt: Date;
}

function durationSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string') return parseDurationSeconds(value);
  return null;
}

/**
 * Parse a create body. `every` (duration) or `cron` makes the reminder recurring;
 * `at` (ISO-8601) or `in` (duration) sets the first fire. `at`/`in` alone is a
 * one-shot reminder. Durations are `30m`, `1h`, `2d`, or whole seconds.
 */
export function parseReminderDraft(body: Record<string, unknown>, now: Date): ReminderDraft | { error: string } {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return { error: 'prompt is required' };
  if (prompt.length > REMINDER_PROMPT_MAX_LENGTH) {
    return { error: `prompt must be at most ${REMINDER_PROMPT_MAX_LENGTH} characters` };
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  if (name && name.length > REMINDER_NAME_MAX_LENGTH) {
    return { error: `name must be at most ${REMINDER_NAME_MAX_LENGTH} characters` };
  }

  const has = (key: string) => body[key] !== undefined && body[key] !== null;
  if (has('every') && has('cron')) return { error: 'Pass every or cron, not both' };
  if (has('at') && has('in')) return { error: 'Pass at or in, not both' };
  if (has('cron') && (has('at') || has('in'))) {
    return { error: 'A cron reminder sets its own fire times; drop at/in' };
  }
  if (!has('every') && !has('cron') && !has('at') && !has('in')) {
    return { error: 'Say when the reminder fires: every, cron, at, or in' };
  }

  let start: Date | null = null;
  if (has('at')) {
    const ms = typeof body.at === 'string' ? Date.parse(body.at) : Number.NaN;
    if (Number.isNaN(ms)) return { error: 'at must be an ISO-8601 instant, e.g. 2026-10-01T09:00:00Z' };
    if (ms - now.getTime() > REMINDER_MAX_HORIZON_SECONDS * 1000) return { error: `at ${HORIZON_LIMIT} from now` };
    start = new Date(ms);
  } else if (has('in')) {
    const seconds = durationSeconds(body.in);
    if (!seconds) return { error: 'in must be a duration like 30m, 24h, or 2d' };
    if (seconds > REMINDER_MAX_HORIZON_SECONDS) return { error: `in ${HORIZON_LIMIT}` };
    start = new Date(now.getTime() + seconds * 1000);
  }
  if (start && start.getTime() <= now.getTime()) return { error: 'at must be in the future' };

  const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'UTC';
  const timezoneError = validateTriggerTimezone(timezone);
  if (timezoneError) return { error: timezoneError };

  let everySeconds: number | null = null;
  if (has('every')) {
    everySeconds = durationSeconds(body.every);
    if (!everySeconds) return { error: 'every must be a duration like 30m, 1h, or 1d' };
    if (everySeconds > REMINDER_MAX_HORIZON_SECONDS) return { error: `every ${HORIZON_LIMIT}` };
    if (everySeconds < REMINDER_MIN_INTERVAL_SECONDS) {
      return { error: `every must be at least ${formatDurationSeconds(REMINDER_MIN_INTERVAL_SECONDS)}` };
    }
  }

  let cron: string | null = null;
  let cronFirst: Date | null = null;
  if (has('cron')) {
    cron = typeof body.cron === 'string' ? body.cron.trim() : '';
    const cronError = cron ? validateTriggerCron(cron, timezone) : 'cron must be a cron expression';
    if (cronError) return { error: cronError };
    const schedule = new Cron(cron, { paused: true, timezone });
    cronFirst = schedule.nextRun(now);
    const second = cronFirst ? schedule.nextRun(cronFirst) : null;
    if (!cronFirst) return { error: 'cron never fires after now' };
    if (second && second.getTime() - cronFirst.getTime() < REMINDER_MIN_INTERVAL_SECONDS * 1000) {
      return { error: `cron must fire at most once per ${formatDurationSeconds(REMINDER_MIN_INTERVAL_SECONDS)}` };
    }
  }

  const firstFireAt =
    start ?? cronFirst ?? new Date(now.getTime() + (everySeconds as number) * 1000);
  return { prompt, name, everySeconds, cron, timezone, firstFireAt };
}

export function newReminderId(): string {
  return `reminder.${randomBytes(6).toString('hex')}`;
}

/** The trigger spec the scheduler stores and fires for one reminder. */
export function reminderSpec(input: {
  id: string;
  sessionId: string;
  agent: string;
  draft: ReminderDraft;
  now: Date;
}): GitTriggerSpec {
  const { draft } = input;
  const oneShot = !draft.everySeconds && !draft.cron;
  return {
    slug: input.id,
    path: '',
    name: draft.name ?? input.id,
    type: 'cron',
    agent: input.agent,
    model: null,
    enabled: true,
    promptTemplate: draft.prompt,
    cron: draft.cron,
    runAt: oneShot ? draft.firstFireAt.toISOString() : null,
    timezone: draft.timezone,
    secretEnv: null,
    run: null,
    monitorMode: null,
    intervalSeconds: null,
    expectEventWithinSeconds: null,
    sessionMode: 'pinned',
    pinnedSessionId: input.sessionId,
    sessionKey: null,
    filter: null,
    reminder: { everySeconds: draft.everySeconds, createdAt: input.now.toISOString() },
  };
}

/** The text a fire delivers — `@kortix/shared` owns the format so web/mobile parse the same header. */
export function reminderPromptText(spec: GitTriggerSpec): string {
  return sharedReminderPromptText({ id: spec.slug, recurring: !spec.runAt, prompt: spec.promptTemplate });
}

type RuntimeRow = typeof projectTriggerRuntime.$inferSelect;

export type ReminderState = 'active' | 'paused' | 'done';

export function serializeSessionReminder(row: RuntimeRow) {
  const spec = row.scheduleSpec as unknown as GitTriggerSpec;
  const everySeconds = spec.reminder?.everySeconds ?? null;
  const state: ReminderState = !row.enabled ? 'paused' : row.nextFireAt ? 'active' : 'done';
  return {
    id: row.slug,
    session_id: row.sessionId,
    name: spec.name === row.slug ? null : spec.name,
    prompt: spec.promptTemplate,
    every: everySeconds ? formatDurationSeconds(everySeconds) : null,
    every_seconds: everySeconds,
    cron: spec.cron,
    timezone: spec.timezone,
    at: spec.runAt,
    state,
    next_fire_at: row.nextFireAt?.toISOString() ?? null,
    last_fired_at: row.lastFiredAt?.toISOString() ?? null,
    last_status: row.lastStatus,
    last_error: row.lastError,
    created_by: row.ownerUserId,
    created_at: spec.reminder?.createdAt ?? null,
  };
}

const isReminderRow = sql`${projectTriggerRuntime.scheduleSpec} ->> 'reminder' is not null`;

export async function listSessionReminders(projectId: string, sessionId: string): Promise<RuntimeRow[]> {
  return db
    .select()
    .from(projectTriggerRuntime)
    .where(
      and(
        eq(projectTriggerRuntime.projectId, projectId),
        eq(projectTriggerRuntime.sessionId, sessionId),
        isReminderRow,
      ),
    )
    .orderBy(
      asc(sql`${projectTriggerRuntime.scheduleSpec} -> 'reminder' ->> 'createdAt'`),
      asc(projectTriggerRuntime.slug),
    );
}

/** Rows the project page reads. Callers filter by session visibility. */
export const PROJECT_REMINDER_LIST_LIMIT = 200;

/**
 * Every reminder in a project: active by next fire, then paused, then done by
 * last fire. Unpinned rows (their session row is gone) are left out.
 */
export async function listProjectReminders(projectId: string): Promise<RuntimeRow[]> {
  return db
    .select()
    .from(projectTriggerRuntime)
    .where(
      and(
        eq(projectTriggerRuntime.projectId, projectId),
        isNotNull(projectTriggerRuntime.sessionId),
        isReminderRow,
      ),
    )
    .orderBy(
      sql`case when ${projectTriggerRuntime.enabled} and ${projectTriggerRuntime.nextFireAt} is not null then 0 when not ${projectTriggerRuntime.enabled} then 1 else 2 end`,
      sql`${projectTriggerRuntime.nextFireAt} asc nulls last`,
      sql`${projectTriggerRuntime.lastFiredAt} desc nulls last`,
      asc(projectTriggerRuntime.slug),
    )
    // ponytail: one page of 200; add a cursor when a project holds more.
    .limit(PROJECT_REMINDER_LIST_LIMIT);
}

export async function getSessionReminder(
  projectId: string,
  sessionId: string,
  id: string,
): Promise<RuntimeRow | null> {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(
      and(
        eq(projectTriggerRuntime.projectId, projectId),
        eq(projectTriggerRuntime.sessionId, sessionId),
        eq(projectTriggerRuntime.slug, id),
        isReminderRow,
      ),
    )
    .limit(1);
  return row ?? null;
}

type Db = Pick<typeof db, 'select' | 'insert'>;

const activeReminder = [
  eq(projectTriggerRuntime.enabled, true),
  isNotNull(projectTriggerRuntime.nextFireAt),
  isReminderRow,
] as const;

export async function countActiveSessionReminders(projectId: string, sessionId: string, q: Db = db): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(projectTriggerRuntime)
    .where(
      and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.sessionId, sessionId), ...activeReminder),
    );
  return Number(row?.n ?? 0);
}

async function countActiveProjectReminders(projectId: string, q: Db): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), ...activeReminder));
  return Number(row?.n ?? 0);
}

/**
 * Insert a reminder unless the session or the project is at its cap. The count and
 * the insert run under one per-project advisory lock: without it, concurrent creates
 * all read the same count and step past the cap (40 parallel POSTs stored 40).
 */
export async function insertSessionReminderWithinCaps(
  input: Parameters<typeof insertSessionReminder>[0],
): Promise<{ row: RuntimeRow } | { error: string }> {
  const { projectId } = input;
  const sessionId = input.spec.pinnedSessionId as string;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`reminders:${projectId}`}, 0))`);
    if ((await countActiveSessionReminders(projectId, sessionId, tx)) >= REMINDER_MAX_ACTIVE_PER_SESSION) {
      return { error: `This session already has ${REMINDER_MAX_ACTIVE_PER_SESSION} active reminders. Stop one first.` };
    }
    if ((await countActiveProjectReminders(projectId, tx)) >= REMINDER_MAX_ACTIVE_PER_PROJECT) {
      return { error: `This project already has ${REMINDER_MAX_ACTIVE_PER_PROJECT} active reminders. Stop one first.` };
    }
    return { row: await insertSessionReminder(input, tx) };
  });
}

export async function insertSessionReminder(input: {
  projectId: string;
  spec: GitTriggerSpec;
  createdBy: string;
  firstFireAt: Date;
  now: Date;
}, q: Db = db): Promise<RuntimeRow> {
  const { spec } = input;
  const [row] = await q
    .insert(projectTriggerRuntime)
    .values({
      projectId: input.projectId,
      slug: spec.slug,
      sessionId: spec.pinnedSessionId,
      ownerUserId: input.createdBy,
      triggerType: 'cron',
      enabled: true,
      scheduleCron: spec.cron,
      scheduleRunAt: spec.runAt ? new Date(spec.runAt) : null,
      scheduleTimezone: spec.timezone,
      scheduleRevision: triggerScheduleRevision(spec),
      scheduleSpec: spec as unknown as Record<string, unknown>,
      nextFireAt: input.firstFireAt,
      updatedAt: input.now,
    })
    .returning();
  return row!;
}

/**
 * Turn a reminder on or off. On re-arms from now: a recurring reminder fires one period
 * (or the next cron slot) later; a one-shot reminder that never fired fires at its
 * `at`, or at once when `at` already passed; a one-shot reminder that fired stays done.
 */
export async function setSessionReminderEnabled(row: RuntimeRow, enabled: boolean, now: Date): Promise<RuntimeRow> {
  const spec = row.scheduleSpec as unknown as GitTriggerSpec;
  const nextFireAt = !enabled
    ? null
    : spec.runAt && row.lastScheduledFor
      ? null
      : nextTriggerScheduleSlot(spec, now, { includePastOneOff: true });
  const [updated] = await db
    .update(projectTriggerRuntime)
    .set({ enabled, nextFireAt, updatedAt: now })
    .where(and(eq(projectTriggerRuntime.projectId, row.projectId), eq(projectTriggerRuntime.slug, row.slug)))
    .returning();
  return updated ?? row;
}

export async function deleteSessionReminder(projectId: string, id: string): Promise<void> {
  await db
    .delete(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, id), isReminderRow));
}

/** A fire found the reminder's session gone: switch the reminder off so it stops firing. */
export async function disableSessionReminder(projectId: string, id: string, now: Date): Promise<void> {
  await db
    .update(projectTriggerRuntime)
    .set({ enabled: false, nextFireAt: null, updatedAt: now })
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, id), isReminderRow));
}
