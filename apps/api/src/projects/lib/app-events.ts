/**
 * App events: an App of the project POSTs named events, and every enabled
 * `type: app` trigger naming that App gets one row in the monitor event log.
 * Everything after the append (rate limits, suppression, dedup, the drain,
 * filter, prompt, session) is the monitor path, unchanged
 * (./monitor-ingest.ts, ./monitor-observer.ts).
 */
import { projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../shared/db';
import { MONITOR_INGEST_MAX_EVENTS, truncateMonitorLine, type ParsedMonitorEvent } from './monitor-events';
import { type MonitorIngestResult, ingestMonitorEvents } from './monitor-ingest';

export interface AppEventInput {
  name: string;
  data?: Record<string, unknown>;
  /** The App's own id for the event. The same id on one trigger is accepted once. */
  id?: string;
}

const EVENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Validate a POST body: one event object, or `{ events: [...] }`. */
export function parseAppEventsBody(body: Record<string, unknown>): AppEventInput[] | { error: string } {
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

/** A dedup key from the App's event id: 52 bits, so it fits the bigint `seq` as a JS number. */
function eventSeq(id: string): number {
  return Number.parseInt(createHash('sha256').update(id).digest('hex').slice(0, 13), 16);
}

export async function ingestAppEvents(input: {
  projectId: string;
  appId: string;
  appSlug: string;
  events: readonly AppEventInput[];
  now?: Date;
}): Promise<MonitorIngestResult & { triggers: number }> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({ slug: projectTriggerRuntime.slug, enabled: projectTriggerRuntime.enabled, scheduleSpec: projectTriggerRuntime.scheduleSpec })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, input.projectId), eq(projectTriggerRuntime.triggerType, 'app')));
  const slugs = rows
    .filter((row) => row.enabled !== false && (row.scheduleSpec as { app?: string } | null)?.app === input.appSlug)
    .map((row) => row.slug);
  if (slugs.length === 0) return { accepted: 0, deduped: 0, suppressed: 0, triggers: 0 };

  const parsed: ParsedMonitorEvent[] = input.events.flatMap((event) => {
    // An event without an id is never deduplicated: each POST is a new event.
    const seq = eventSeq(event.id ?? randomUUID());
    const line = truncateMonitorLine({ name: event.name, data: event.data ?? {}, ...(event.id ? { id: event.id } : {}) });
    return slugs.map((slug) => ({ slug, seq, kind: 'event' as const, line, emittedAt: now }));
  });
  const result = await ingestMonitorEvents({ projectId: input.projectId, boxEpoch: `app:${input.appId}`, events: parsed, now });
  return { ...result, triggers: slugs.length };
}
