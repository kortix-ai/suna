/**
 * The monitor observer — the drain half of the event log.
 *
 * `project_monitor_events` IS the fire queue (spec D2): the ingest route
 * appends `pending` rows, and this drain claims them on the leader's scheduler
 * tick and hands each one to `fireGitTrigger`, which lands in the durable
 * session-lifecycle queue exactly like a cron slot does. Everything downstream
 * of the log — filter, template, session_mode, dedup, retry, agent/model,
 * identity — is the existing trigger path, unchanged (spec D1).
 *
 * The claim idiom is `trigger-execution-store.ts`'s: select candidates, then
 * compare-and-swap on `attempts`, so two schedulers racing the same row leave
 * exactly one winner.
 */
import { projectMonitorEvents, projectTriggerRuntime, projects } from '@kortix/db';
import { and, asc, eq, lt } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import type { GitTriggerSpec } from '../triggers';
import {
  MONITOR_PROMPT_PREAMBLE,
  type MonitorEventKind,
  buildMonitorPayload,
  renderMonitorLifecyclePrompt,
} from './monitor-events';
import { renderPromptTemplate, triggerFilterMatches } from './trigger-payload';
import { fireGitTrigger, markGitTriggerAttemptFailed, markGitTriggerFired } from './trigger-fire';
import { raiseTriggerAlert } from './trigger-alerts';
import { triggersPausedForProject } from './trigger-scheduler-state';

/** Attempts after which an event dead-letters as `failed`. Mirrors the
 *  execution queue's ceiling so both queues fail the same way. */
export const MONITOR_EVENT_MAX_ATTEMPTS = 5;
/** Events claimed per drain. Matches the ingest batch bound. */
export const MONITOR_DRAIN_LIMIT = 50;

export type MonitorEventRow = typeof projectMonitorEvents.$inferSelect;

export interface MonitorDrainResult {
  fired: number;
  skipped: number;
  failed: number;
}

let monitorDrainRunning = false;

/**
 * Claim up to `limit` pending events. The CAS on `attempts` is the whole
 * mutual exclusion: the loser's UPDATE matches zero rows and returns nothing.
 */
export async function claimMonitorEvents(input: {
  limit: number;
}): Promise<MonitorEventRow[]> {
  const candidates = await db
    .select()
    .from(projectMonitorEvents)
    .where(
      and(
        eq(projectMonitorEvents.status, 'pending'),
        lt(projectMonitorEvents.attempts, MONITOR_EVENT_MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(projectMonitorEvents.ingestedAt))
    .limit(input.limit);

  const claimed: MonitorEventRow[] = [];
  for (const candidate of candidates) {
    const [row] = await db
      .update(projectMonitorEvents)
      .set({ attempts: candidate.attempts + 1 })
      .where(
        and(
          eq(projectMonitorEvents.eventId, candidate.eventId),
          eq(projectMonitorEvents.status, 'pending'),
          eq(projectMonitorEvents.attempts, candidate.attempts),
        ),
      )
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

async function markMonitorEvent(
  eventId: string,
  status: 'fired' | 'skipped' | 'failed',
  now: Date,
  extra: { sessionId?: string | null; lastError?: string | null } = {},
): Promise<void> {
  await db
    .update(projectMonitorEvents)
    .set({
      status,
      sessionId: extra.sessionId ?? null,
      lastError: extra.lastError ? extra.lastError.slice(0, 2_000) : null,
      firedAt: status === 'fired' ? now : null,
    })
    .where(eq(projectMonitorEvents.eventId, eventId));
}

/**
 * Process one claimed event.
 *
 * `lifecycle` events bypass the author's `filter` and use a platform-rendered
 * prompt: a monitor that died must produce a legible turn even when the
 * template only knows how to format a healthy line, and silence must not be
 * filterable by accident (spec §"Event payload").
 */
export async function processMonitorEvent(
  row: MonitorEventRow,
  now: Date,
): Promise<'fired' | 'skipped' | 'failed'> {
  /** Mark the event `skipped` for `reason` and answer the drain's tally. */
  const skip = (reason: string): Promise<'skipped'> =>
    markMonitorEvent(row.eventId, 'skipped', now, { lastError: reason }).then(() => 'skipped' as const);

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, row.projectId))
    .limit(1);
  if (!project || project.status !== 'active') {
    return skip(project ? 'project is not active' : 'project not found');
  }
  // A monitor fire is project automation, so the project-wide pause switch
  // stops it exactly like it stops a cron fire.
  if (triggersPausedForProject(project.metadata)) {
    return skip('project triggers are paused');
  }
  // Behavioral half of the flag (spec §"Feature flag"): turning `monitors` off
  // stops firing even if the ingest route were somehow bypassed.
  if (!resolveFeatureFlag(project.metadata, 'monitors')) {
    return skip('monitors is not enabled for this project');
  }

  const [runtime] = await db
    .select({
      enabled: projectTriggerRuntime.enabled,
      triggerType: projectTriggerRuntime.triggerType,
      scheduleSpec: projectTriggerRuntime.scheduleSpec,
    })
    .from(projectTriggerRuntime)
    .where(
      and(
        eq(projectTriggerRuntime.projectId, row.projectId),
        eq(projectTriggerRuntime.slug, row.slug),
      ),
    )
    .limit(1);
  if (!runtime?.scheduleSpec || runtime.triggerType !== 'monitor') {
    return skip('monitor is not declared in the project manifest');
  }
  if (runtime.enabled === false) {
    return skip('monitor is disabled');
  }

  const spec = runtime.scheduleSpec as unknown as GitTriggerSpec;
  const kind = row.kind as MonitorEventKind;
  const payload = buildMonitorPayload({
    slug: row.slug,
    seq: Number(row.seq),
    kind,
    line: row.line,
    emittedAt: row.emittedAt,
  });

  let body: string;
  if (kind === 'lifecycle') {
    body = renderMonitorLifecyclePrompt(spec, row.line);
  } else {
    if (!triggerFilterMatches(spec, payload)) {
      await skip('filter did not match');
      await touchMonitorLastEvent(row.projectId, row.slug, row.emittedAt, now);
      return 'skipped';
    }
    body = renderPromptTemplate(spec.promptTemplate, payload);
  }
  const renderedPrompt = `${MONITOR_PROMPT_PREAMBLE}${body}`;

  // Per (project, slug, epoch, seq) — the same key the log dedups on, so a
  // re-claimed event can never mint a second session.
  const idempotencyKey = `trigger:monitor:${row.projectId}:${row.slug}:${row.boxEpoch}:${row.seq}`;
  try {
    const result = await fireGitTrigger({
      spec,
      project,
      payload,
      renderedPrompt,
      source: 'monitor',
      idempotencyKey,
    });
    if (result.status === 'fired' || result.status === 'queued') {
      await markMonitorEvent(row.eventId, 'fired', now, { sessionId: result.sessionId ?? null });
      await touchMonitorLastEvent(row.projectId, row.slug, row.emittedAt, now);
      // The trigger's last_fired_at / last_status, as every other source stamps
      // them; it also clears a failed fire recorded below. Display state only:
      // a failed stamp must not send this fired event back to `pending`.
      await markGitTriggerFired(row.projectId, row.slug, now, result.status).catch(() => {});
      return 'fired';
    }
    return await failMonitorEvent(row, now, result.error ?? result.reason ?? 'monitor fire failed');
  } catch (error) {
    return await failMonitorEvent(row, now, error instanceof Error ? error.message : String(error));
  }
}

/**
 * A failed attempt stays `pending` so the next tick retries it, until the
 * attempt ceiling turns it into a dead-lettered `failed` row. The trigger
 * records every failed attempt, like a failed cron fire (KRTX-1743); the dead
 * letter alerts its watchers (KRTX-1742).
 */
async function failMonitorEvent(row: MonitorEventRow, now: Date, error: string): Promise<'failed'> {
  const terminal = row.attempts >= MONITOR_EVENT_MAX_ATTEMPTS;
  await db
    .update(projectMonitorEvents)
    .set({
      status: terminal ? 'failed' : 'pending',
      lastError: error.slice(0, 2_000),
    })
    .where(eq(projectMonitorEvents.eventId, row.eventId));
  await markGitTriggerAttemptFailed(row.projectId, row.slug, now, error).catch(() => {});
  if (terminal) await raiseTriggerAlert({ projectId: row.projectId, slug: row.slug, source: 'fire', error });
  return 'failed';
}

async function touchMonitorLastEvent(
  projectId: string,
  slug: string,
  emittedAt: Date,
  now: Date,
): Promise<void> {
  await db
    .update(projectTriggerRuntime)
    .set({ lastEventAt: emittedAt, updatedAt: now })
    .where(
      and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
    );
}

/**
 * One drain pass. Wired into the leader's scheduler tick beside
 * `drainTriggerExecutionQueue`; re-entrancy is blocked the same way the
 * execution drain blocks it.
 */
export async function drainMonitorEvents(now = new Date()): Promise<MonitorDrainResult> {
  const result: MonitorDrainResult = { fired: 0, skipped: 0, failed: 0 };
  if (monitorDrainRunning) return result;
  monitorDrainRunning = true;
  try {
    const rows = await claimMonitorEvents({ limit: MONITOR_DRAIN_LIMIT });
    for (const row of rows) {
      result[await processMonitorEvent(row, now)] += 1;
    }
    return result;
  } finally {
    monitorDrainRunning = false;
  }
}
