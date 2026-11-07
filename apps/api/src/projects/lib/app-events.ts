/**
 * App events: an App of the project POSTs named events, and every enabled
 * `type: app` trigger naming that App gets one row in the monitor event log.
 * Everything after the append (rate limits, suppression, dedup, the drain,
 * filter, prompt, session) is the monitor path, unchanged
 * (./monitor-ingest.ts, ./monitor-observer.ts).
 *
 * An event that no enabled trigger listens to is kept too, as an `unmatched`
 * row (slug `''`, status `skipped`): the App's event log then shows that the
 * App posted and why nothing ran. Unmatched rows never fire, and they do not
 * spend the event's id: a trigger added later still fires on a retry.
 */
import { apps, projectMonitorEvents, projectTriggerRuntime } from '@kortix/db';
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { MONITOR_INGEST_MAX_EVENTS, MONITOR_RATE_WINDOW_MS, truncateMonitorLine, type ParsedMonitorEvent } from './monitor-events';
import { type MonitorIngestResult, ingestMonitorEvents } from './monitor-ingest';
import { clearTriggerAlert } from './trigger-alerts';

export interface AppEventInput {
  name: string;
  data?: Record<string, unknown>;
  /** The App's own id for the event. The same id on one trigger is accepted once. */
  id?: string;
}

const EVENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * `kortix.heartbeat`: "this App is alive". It counts as heard for
 * `expect_event_within` and is never stored and never fires. Every other
 * `kortix.` name is reserved for events Kortix itself writes.
 */
export const HEARTBEAT_EVENT_NAME = 'kortix.heartbeat';
const RESERVED_PREFIX = 'kortix.';

/**
 * Events Kortix writes about an App, so an agent can repair it:
 * - `kortix.app.silent`: a trigger's `expect_event_within` passed with no event;
 * - `kortix.app.recovered`: the App posted again, or its machine runs again;
 * - `kortix.app.crashed`: an always-on App's process stopped 3 times in an hour.
 * One reaches only a `type: app` trigger whose event is that exact name
 * (`on: { event: kortix.app.silent, app: <slug> }`), never `event: "*"`, and
 * it never counts as the App posting.
 */
export const APP_PLATFORM_EVENTS = ['kortix.app.silent', 'kortix.app.recovered', 'kortix.app.crashed'] as const;
export type AppPlatformEventName = (typeof APP_PLATFORM_EVENTS)[number];

export function isAppPlatformEvent(name: string): name is AppPlatformEventName {
  return (APP_PLATFORM_EVENTS as readonly string[]).includes(name);
}

/** The slug of an `unmatched` row: no trigger slug is empty. */
export const UNMATCHED_SLUG = '';
/** Unmatched events kept per App in a trailing hour. Past it they are counted, not stored. */
export const UNMATCHED_KEPT_PER_HOUR = 60;

/**
 * Validate a POST body: one event object, or `{ events: [...] }`. With
 * `platform`, the test route's option, a `kortix.app.*` name is allowed too.
 */
export function parseAppEventsBody(body: Record<string, unknown>, options: { platform?: boolean } = {}): AppEventInput[] | { error: string } {
  const list = Array.isArray(body.events) ? body.events : [body];
  if (list.length === 0) return { error: 'events must contain at least one event' };
  if (list.length > MONITOR_INGEST_MAX_EVENTS) return { error: `send at most ${MONITOR_INGEST_MAX_EVENTS} events per request` };
  const events: AppEventInput[] = [];
  for (const [i, raw] of list.entries()) {
    const at = Array.isArray(body.events) ? `events[${i}].` : '';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at || 'body '}must be an object` };
    const { name, data, id } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) {
      return { error: `${at}name must be 1-128 characters: letters, digits and . _ : / -, starting with a letter or digit` };
    }
    if (name.startsWith(RESERVED_PREFIX) && name !== HEARTBEAT_EVENT_NAME && !(options.platform && isAppPlatformEvent(name))) {
      return { error: `${at}name: names starting with "kortix." are reserved; an App sends only "${HEARTBEAT_EVENT_NAME}"` };
    }
    if (data !== undefined && (!data || typeof data !== 'object' || Array.isArray(data))) {
      return { error: `${at}data must be an object` };
    }
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 256)) {
      return { error: `${at}id must be a string of 1-256 characters` };
    }
    events.push({ name, ...(data ? { data: data as Record<string, unknown> } : {}), ...(id ? { id } : {}) });
  }
  return events;
}

/** The id prefix every test event carries, so a test never spends a real event id. */
export const TEST_EVENT_ID_PREFIX = 'test-';

/**
 * Events a person or agent sends to test the wiring (`POST …/events/test`):
 * every id starts with `test-` (one is made when none was sent), so a real
 * event with the same id still fires later.
 */
export function asTestEvents(events: readonly AppEventInput[]): AppEventInput[] {
  return events.map((event) => ({
    ...event,
    id: event.id?.startsWith(TEST_EVENT_ID_PREFIX) ? event.id : `${TEST_EVENT_ID_PREFIX}${event.id ?? randomUUID()}`,
  }));
}

/** The stored line of one event; a test event carries `test: true` (the prompt reads it as `event.test`). */
function eventLine(event: AppEventInput, test: boolean): Record<string, unknown> {
  const line = truncateMonitorLine({ name: event.name, data: event.data ?? {}, ...(event.id ? { id: event.id } : {}), ...(test ? { test: true } : {}) });
  // A truncated line is `{raw, truncated}`: a test event keeps its mark (the TEST preamble, the log and the
  // silence check read it). It fits the envelope room truncateMonitorLine reserves.
  return test ? { ...line, test: true } : line;
}

/** A dedup key from the App's event id: 52 bits, so it fits the bigint `seq` as a JS number. */
function eventSeq(id: string): number {
  return Number.parseInt(createHash('sha256').update(id).digest('hex').slice(0, 13), 16);
}

export interface AppEventIngestResult extends MonitorIngestResult {
  /** Enabled triggers that name the App. */
  triggers: number;
  /** Events no enabled trigger listens to (kept as `unmatched`, up to the hourly bound). */
  unmatched: number;
  /** `kortix.heartbeat` events: counted as heard, never stored. */
  heartbeats?: number;
  /** What to do when `unmatched` is not 0. */
  hint?: string;
}

/** Why an event matched no trigger, for the log row and the POST answer. */
export function unmatchedReason(appSlug: string, disabledSlugs: readonly string[]): string {
  if (disabledSlugs.length > 0) {
    return `every trigger on App "${appSlug}" is disabled (${disabledSlugs.join(', ')}): enable one to run it`;
  }
  return `no trigger listens to App "${appSlug}": add one with kortix triggers add <slug> --type app --app ${appSlug} --prompt "…" --apply`;
}

export async function ingestAppEvents(input: {
  projectId: string;
  appId: string;
  appSlug: string;
  events: readonly AppEventInput[];
  /** Sent through the test route: the events must already carry `test-` ids (asTestEvents). */
  test?: boolean;
  /** The test route's `trigger`: only this trigger gets the events, so a test of one automation starts no other. */
  only?: string;
  now?: Date;
}): Promise<AppEventIngestResult> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      slug: projectTriggerRuntime.slug,
      enabled: projectTriggerRuntime.enabled,
      scheduleSpec: projectTriggerRuntime.scheduleSpec,
      alertSource: projectTriggerRuntime.alertSource,
    })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, input.projectId), eq(projectTriggerRuntime.triggerType, 'app')));
  // A trigger on a kortix.app.* name hears only Kortix (emitAppPlatformEvent): an App's own event never matches it.
  const named = rows.filter((row) => {
    const spec = row.scheduleSpec as { app?: string; filter?: Record<string, unknown> | null } | null;
    const event = spec?.filter?.['event.name'];
    return spec?.app === input.appSlug && !(typeof event === 'string' && isAppPlatformEvent(event));
  });
  const slugs = named.filter((row) => row.enabled !== false && (!input.only || row.slug === input.only)).map((row) => row.slug);
  const heartbeats = input.events.filter((event) => event.name === HEARTBEAT_EVENT_NAME).length;
  if (heartbeats > 0) {
    const events = input.events.filter((event) => event.name !== HEARTBEAT_EVENT_NAME);
    const rest = events.length > 0 ? await ingestAppEvents({ ...input, events }) : null;
    if (!rest && input.test !== true && slugs.length > 0) {
      const silent = named.filter((row) => row.enabled !== false && row.alertSource === 'silence').map((row) => row.slug);
      await markAppTriggersHeard(input.projectId, input.appSlug, slugs, silent, now);
    }
    return { ...(rest ?? { accepted: 0, deduped: 0, suppressed: 0, triggers: slugs.length, unmatched: 0 }), heartbeats };
  }
  if (slugs.length === 0) {
    const reason = input.only
      ? `trigger "${input.only}" does not listen to App "${input.appSlug}", or it is disabled: kortix triggers ls`
      : unmatchedReason(input.appSlug, named.map((row) => row.slug));
    const kept = await keepUnmatchedEvents({ ...input, test: input.test === true, now, reason });
    return { accepted: 0, deduped: kept.deduped, suppressed: 0, triggers: 0, unmatched: input.events.length, hint: reason };
  }

  const parsed: ParsedMonitorEvent[] = input.events.flatMap((event) => {
    // An event without an id is never deduplicated: each POST is a new event.
    const seq = eventSeq(event.id ?? randomUUID());
    const line = eventLine(event, input.test === true);
    return slugs.map((slug) => ({ slug, seq, kind: 'event' as const, line, emittedAt: now }));
  });
  const result = await ingestMonitorEvents({ projectId: input.projectId, boxEpoch: `app:${input.appId}`, events: parsed, now });
  // The App is alive: a deduplicated event counts (a watcher posts the same
  // content id while nothing changes). A test event is not the App speaking.
  if (input.test !== true) {
    const silent = named.filter((row) => row.enabled !== false && row.alertSource === 'silence').map((row) => row.slug);
    await markAppTriggersHeard(input.projectId, input.appSlug, slugs, silent, now);
  }
  return { ...result, triggers: slugs.length, unmatched: 0 };
}

/**
 * Stamp `last_event_at` on the triggers an App just posted to, so the silence
 * check (app-trigger-silence.ts) knows the App is alive, and end the silence
 * alert of each that had one, with `kortix.app.recovered` for a repair
 * trigger. Never throws: the events are already stored.
 */
async function markAppTriggersHeard(projectId: string, appSlug: string, slugs: readonly string[], silent: readonly string[], now: Date): Promise<void> {
  try {
    await db
      .update(projectTriggerRuntime)
      .set({ lastEventAt: now })
      .where(and(eq(projectTriggerRuntime.projectId, projectId), inArray(projectTriggerRuntime.slug, [...slugs])));
    for (const slug of silent) {
      if (!(await clearTriggerAlert({ projectId, slug, source: 'silence' }))) continue;
      await emitAppPlatformEvent({
        projectId, appSlug, name: 'kortix.app.recovered', id: `recovered:${slug}:${now.getTime()}`,
        data: { trigger: slug, cause: 'silence' }, now,
      });
    }
  } catch {
    // The next event stamps it again.
  }
}

export interface AppPlatformEventResult extends MonitorIngestResult {
  /** Enabled triggers whose event is this exact name. */
  triggers: number;
  /** 1 when no trigger listens (kept as `unmatched`, so the App's log still shows it). */
  unmatched: number;
  hint?: string;
}

/**
 * Write a platform event (`APP_PLATFORM_EVENTS`) to the App's log: one row per
 * enabled trigger whose event is this exact name, then the usual limits and
 * drain. With none, one `unmatched` row records it. It never stamps
 * `last_event_at`: Kortix speaking about the App is not the App speaking.
 * `id` makes one episode one event. Never throws; null when the App is gone.
 */
export async function emitAppPlatformEvent(input: {
  projectId: string;
  appSlug: string;
  name: AppPlatformEventName;
  id: string;
  data: Record<string, unknown>;
  /** From the test route: the id must already start with `test-`. */
  test?: boolean;
  /** The test route's `trigger`: only this trigger gets it. */
  only?: string;
  now?: Date;
}): Promise<AppPlatformEventResult | null> {
  const now = input.now ?? new Date();
  try {
    const [app] = await db
      .select({ appId: apps.appId })
      .from(apps)
      .where(and(eq(apps.projectId, input.projectId), eq(apps.slug, input.appSlug), isNull(apps.deletedAt)))
      .limit(1);
    if (!app) return null;
    const rows = await db
      .select({ slug: projectTriggerRuntime.slug, enabled: projectTriggerRuntime.enabled, scheduleSpec: projectTriggerRuntime.scheduleSpec })
      .from(projectTriggerRuntime)
      .where(and(eq(projectTriggerRuntime.projectId, input.projectId), eq(projectTriggerRuntime.triggerType, 'app')));
    const slugs = rows
      .filter((row) => {
        const spec = row.scheduleSpec as { app?: string; filter?: Record<string, unknown> | null } | null;
        return row.enabled !== false && spec?.app === input.appSlug && spec.filter?.['event.name'] === input.name
          && (!input.only || row.slug === input.only);
      })
      .map((row) => row.slug);
    const event: AppEventInput = { name: input.name, data: input.data, id: input.id };
    if (slugs.length === 0) {
      const hint = input.only
        ? `trigger "${input.only}" does not listen to ${input.name} on App "${input.appSlug}", or it is disabled: kortix triggers ls`
        : `no trigger listens to ${input.name} on App "${input.appSlug}": add one with on: { event: ${input.name}, app: ${input.appSlug} } to start a repair agent`;
      const kept = await keepUnmatchedEvents({ projectId: input.projectId, appId: app.appId, events: [event], test: input.test === true, now, reason: hint });
      return { accepted: 0, deduped: kept.deduped, suppressed: 0, triggers: 0, unmatched: 1, hint };
    }
    const line = { ...eventLine(event, input.test === true), platform: true };
    const result = await ingestMonitorEvents({
      projectId: input.projectId,
      boxEpoch: `app:${app.appId}`,
      events: slugs.map((slug) => ({ slug, seq: eventSeq(input.id), kind: 'event' as const, line, emittedAt: now })),
      now,
    });
    return { ...result, triggers: slugs.length, unmatched: 0 };
  } catch (error) {
    logger.warn('[app-events] platform event failed', { projectId: input.projectId, app: input.appSlug, name: input.name, error: String(error) });
    return null;
  }
}

/**
 * Store events no trigger listens to as `unmatched` rows, at most
 * {@link UNMATCHED_KEPT_PER_HOUR} per App per hour: they are evidence for the
 * log, not work, so a chatty App must not grow the table without bound.
 */
async function keepUnmatchedEvents(input: {
  projectId: string;
  appId: string;
  events: readonly AppEventInput[];
  test: boolean;
  now: Date;
  reason: string;
}): Promise<{ kept: number; deduped: number }> {
  const boxEpoch = `app:${input.appId}`;
  const [window] = await db
    .select({ count: sql<number>`count(*)` })
    .from(projectMonitorEvents)
    .where(
      and(
        eq(projectMonitorEvents.projectId, input.projectId),
        eq(projectMonitorEvents.slug, UNMATCHED_SLUG),
        eq(projectMonitorEvents.boxEpoch, boxEpoch),
        gte(projectMonitorEvents.ingestedAt, new Date(input.now.getTime() - MONITOR_RATE_WINDOW_MS)),
      ),
    );
  let room = UNMATCHED_KEPT_PER_HOUR - Number(window?.count ?? 0);
  let kept = 0;
  let deduped = 0;
  for (const event of input.events) {
    if (room <= 0) break;
    const inserted = await db
      .insert(projectMonitorEvents)
      .values({
        projectId: input.projectId,
        slug: UNMATCHED_SLUG,
        boxEpoch,
        seq: eventSeq(event.id ?? randomUUID()),
        kind: 'event',
        line: eventLine(event, input.test),
        emittedAt: input.now,
        ingestedAt: input.now,
        status: 'skipped',
        lastError: input.reason,
      })
      .onConflictDoNothing({
        target: [projectMonitorEvents.projectId, projectMonitorEvents.slug, projectMonitorEvents.boxEpoch, projectMonitorEvents.seq],
      })
      .returning({ eventId: projectMonitorEvents.eventId });
    if (inserted[0]) {
      kept += 1;
      room -= 1;
    } else {
      deduped += 1;
    }
  }
  return { kept, deduped };
}

// ─── The App's event log (read) ─────────────────────────────────────────────

export const APP_EVENT_LOG_STATUSES = ['pending', 'fired', 'skipped', 'suppressed', 'failed', 'unmatched'] as const;
export type AppEventLogStatus = (typeof APP_EVENT_LOG_STATUSES)[number];

/** One row of the log: one event as one trigger saw it, or an unmatched event. */
export interface AppEventLogEntry {
  /** The log row's id. */
  log_id: string;
  name: string | null;
  /** The App's own id for the event, when it sent one. */
  id: string | null;
  data: Record<string, unknown> | null;
  /** The event was over 8 KiB: `data` is null and `raw` holds its head. */
  truncated: boolean;
  raw: string | null;
  /** Sent through the test route by a person or agent, not by the App. */
  test: boolean;
  /** The trigger the row belongs to; null when no trigger listened. */
  trigger: string | null;
  status: AppEventLogStatus;
  /** Why it was skipped, suppressed or failed; null when it fired or waits. */
  reason: string | null;
  session_id: string | null;
  attempts: number;
  emitted_at: string;
  received_at: string;
  fired_at: string | null;
}

type LogRow = Pick<
  typeof projectMonitorEvents.$inferSelect,
  'eventId' | 'slug' | 'line' | 'status' | 'lastError' | 'sessionId' | 'attempts' | 'emittedAt' | 'ingestedAt' | 'firedAt'
>;

/** A stored row → the API shape. Pure. */
export function appEventLogEntry(row: LogRow): AppEventLogEntry {
  const line = row.line ?? {};
  const truncated = line.truncated === true;
  const unmatched = row.slug === UNMATCHED_SLUG;
  return {
    log_id: row.eventId,
    name: typeof line.name === 'string' ? line.name : null,
    id: typeof line.id === 'string' ? line.id : null,
    data: !truncated && line.data && typeof line.data === 'object' && !Array.isArray(line.data) ? (line.data as Record<string, unknown>) : null,
    truncated,
    raw: truncated && typeof line.raw === 'string' ? line.raw : null,
    test: line.test === true,
    trigger: unmatched ? null : row.slug,
    status: unmatched ? 'unmatched' : (row.status as AppEventLogStatus),
    reason: row.status === 'fired' ? null : (row.lastError ?? null),
    session_id: row.sessionId ?? null,
    attempts: row.attempts,
    emitted_at: row.emittedAt.toISOString(),
    received_at: row.ingestedAt.toISOString(),
    fired_at: row.firedAt ? row.firedAt.toISOString() : null,
  };
}

/** Keyset cursor: the last row's received time and id. */
export function encodeAppEventCursor(row: { receivedAt: Date; logId: string }): string {
  return Buffer.from(`${row.receivedAt.toISOString()}|${row.logId}`, 'utf8').toString('base64url');
}

export function decodeAppEventCursor(cursor: string): { receivedAt: Date; logId: string } | null {
  const [at, logId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const receivedAt = new Date(at ?? '');
  if (!logId || Number.isNaN(receivedAt.getTime()) || !isUuid(logId)) return null;
  return { receivedAt, logId };
}

/** Newest first. `trigger` narrows to one trigger; `status` to one outcome. */
export async function listAppEventLog(input: {
  projectId: string;
  appId: string;
  limit: number;
  cursor?: { receivedAt: Date; logId: string } | null;
  status?: AppEventLogStatus;
  trigger?: string;
  /** The App's own id for the event (a test event's starts with `test-`). */
  eventId?: string;
}): Promise<{ events: AppEventLogEntry[]; next_cursor: string | null }> {
  const filters = [
    eq(projectMonitorEvents.projectId, input.projectId),
    eq(projectMonitorEvents.boxEpoch, `app:${input.appId}`),
  ];
  if (input.status === 'unmatched') filters.push(eq(projectMonitorEvents.slug, UNMATCHED_SLUG));
  else if (input.status) filters.push(eq(projectMonitorEvents.status, input.status), ne(projectMonitorEvents.slug, UNMATCHED_SLUG));
  if (input.trigger) filters.push(eq(projectMonitorEvents.slug, input.trigger));
  if (input.eventId) filters.push(sql`${projectMonitorEvents.line}->>'id' = ${input.eventId}`);
  if (input.cursor) {
    const { receivedAt, logId } = input.cursor;
    filters.push(
      or(
        lt(projectMonitorEvents.ingestedAt, receivedAt),
        and(eq(projectMonitorEvents.ingestedAt, receivedAt), lt(projectMonitorEvents.eventId, logId)),
      )!,
    );
  }
  const rows = await db
    .select({
      eventId: projectMonitorEvents.eventId,
      slug: projectMonitorEvents.slug,
      line: projectMonitorEvents.line,
      status: projectMonitorEvents.status,
      lastError: projectMonitorEvents.lastError,
      sessionId: projectMonitorEvents.sessionId,
      attempts: projectMonitorEvents.attempts,
      emittedAt: projectMonitorEvents.emittedAt,
      ingestedAt: projectMonitorEvents.ingestedAt,
      firedAt: projectMonitorEvents.firedAt,
    })
    .from(projectMonitorEvents)
    .where(and(...filters))
    .orderBy(desc(projectMonitorEvents.ingestedAt), desc(projectMonitorEvents.eventId))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    events: page.map(appEventLogEntry),
    next_cursor: rows.length > input.limit && last ? encodeAppEventCursor({ receivedAt: last.ingestedAt, logId: last.eventId }) : null,
  };
}
