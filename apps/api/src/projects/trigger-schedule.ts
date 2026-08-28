import { createHash } from 'node:crypto';
import { Cron } from 'croner';

export interface TriggerScheduleSpec {
  slug: string;
  /** `monitor` never schedules — `nextTriggerScheduleSlot` returns null for it,
   *  so the cron sweep's `trigger_type = 'cron'` claim can never see one. */
  type: 'cron' | 'webhook' | 'monitor';
  enabled: boolean;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  agent: string;
  model: string | null;
  promptTemplate: string;
  sessionMode: string;
  pinnedSessionId: string | null;
  sessionKey: string | null;
  filter: Record<string, string> | null;
  /** type=monitor only — see GitTriggerSpec. Absent for cron/webhook. */
  run?: string | null;
  monitorMode?: 'poll' | 'stream' | null;
  intervalSeconds?: number | null;
  expectEventWithinSeconds?: number | null;
}

export function validateTriggerTimezone(timezone: string): string | null {
  if (!timezone.trim()) return 'timezone must not be empty';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return null;
  } catch {
    return `timezone must be a valid IANA name like "UTC" or "America/Los_Angeles" (got "${timezone}")`;
  }
}

export function validateTriggerCron(cron: string, timezone: string): string | null {
  const timezoneError = validateTriggerTimezone(timezone);
  if (timezoneError) return timezoneError;
  try {
    new Cron(cron, { paused: true, timezone });
    return null;
  } catch (error) {
    return `invalid cron expression "${cron}": ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export function triggerScheduleRevision(spec: TriggerScheduleSpec): string {
  const filter = spec.filter
    ? Object.fromEntries(
        Object.entries(spec.filter).sort(([left], [right]) => left.localeCompare(right)),
      )
    : null;
  const scheduleConfig = {
    type: spec.type,
    enabled: spec.enabled,
    cron: spec.cron,
    runAt: spec.runAt,
    timezone: spec.timezone,
    agent: spec.agent,
    model: spec.model,
    promptTemplate: spec.promptTemplate,
    sessionMode: spec.sessionMode,
    pinnedSessionId: spec.pinnedSessionId,
    sessionKey: spec.sessionKey,
    filter,
    // Monitor fields join the hash ONLY for a monitor. Adding them
    // unconditionally would change every existing cron/webhook revision on
    // deploy, and a revision change re-upserts the catalog row — which
    // recomputes `next_fire_at` and would re-arm every already-fired one-off
    // `run_at` trigger in the fleet.
    ...(spec.type === 'monitor'
      ? {
          run: spec.run ?? null,
          monitorMode: spec.monitorMode ?? null,
          intervalSeconds: spec.intervalSeconds ?? null,
          expectEventWithinSeconds: spec.expectEventWithinSeconds ?? null,
        }
      : {}),
  };
  return createHash('sha256').update(JSON.stringify(scheduleConfig)).digest('hex');
}

/**
 * Default spread for identical cron expressions across projects, in ms.
 *
 * A cron expression is shared by every project that copied the same manifest,
 * so an unjittered fleet fires as ONE burst. `0 0 3 * * *` in the project
 * starter put 756 projects on the same millisecond and exhausted the sandbox
 * provider every night (2026-08-26: 779 provisions at 03:00, 654 failed, 346
 * of them `capacity` — while every other hour of that day was 100% healthy at
 * 6–28 provisions). Set `KORTIX_TRIGGER_SCHEDULE_JITTER_WINDOW_MS=0` to
 * restore exact-to-the-second firing.
 */
export function triggerScheduleJitterWindowMs(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_SCHEDULE_JITTER_WINDOW_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 1_800_000; // 30 minutes
}

/**
 * Deterministic offset in `[0, windowMs)` for one trigger.
 *
 * Deterministic on purpose: the catalog writes `next_fire_at` and the claim
 * sweep RECOMPUTES it from the same spec. A random offset would make those two
 * disagree and either double-fire or skip a slot. Same key ⇒ same offset,
 * forever, on every API instance.
 */
export function triggerScheduleJitterMs(key: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  return createHash('sha256').update(key).digest().readUInt32BE(0) % windowMs;
}

/**
 * The jitter actually applied to one cron, capped at a quarter of its own
 * period. Without the cap a 30-minute spread would mangle a five-minute cron;
 * with it, a five-minute cron spreads by at most 75s and a daily cron gets the
 * full window.
 */
function cronJitterMs(cron: Cron, after: Date, key: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  const first = cron.nextRun(after);
  if (!first) return 0;
  const second = cron.nextRun(first);
  if (!second) return 0;
  const periodMs = second.getTime() - first.getTime();
  const cappedWindow = Math.min(windowMs, Math.floor(periodMs / 4));
  return triggerScheduleJitterMs(key, cappedWindow);
}

export function nextTriggerScheduleSlot(
  spec: Pick<TriggerScheduleSpec, 'type' | 'enabled' | 'cron' | 'runAt' | 'timezone'>,
  after: Date,
  options: { includePastOneOff?: boolean; jitterKey?: string; jitterWindowMs?: number } = {},
): Date | null {
  if (spec.type !== 'cron' || !spec.enabled) return null;
  if (spec.runAt) {
    const runAtMs = Date.parse(spec.runAt);
    if (Number.isNaN(runAtMs)) return null;
    if (runAtMs > after.getTime()) return new Date(runAtMs);
    return options.includePastOneOff ? new Date(runAtMs) : null;
  }
  if (!spec.cron) return null;
  const error = validateTriggerCron(spec.cron, spec.timezone);
  if (error) throw new Error(error);
  const cron = new Cron(spec.cron, { paused: true, timezone: spec.timezone });
  if (!options.jitterKey) return cron.nextRun(after);
  const jitterMs = cronJitterMs(
    cron,
    after,
    options.jitterKey,
    options.jitterWindowMs ?? triggerScheduleJitterWindowMs(),
  );
  if (jitterMs <= 0) return cron.nextRun(after);
  // Search from `after - jitter` so the jittered result is still strictly after
  // `after` — otherwise a slot whose base already passed would be skipped.
  const base = cron.nextRun(new Date(after.getTime() - jitterMs));
  return base ? new Date(base.getTime() + jitterMs) : null;
}

export function initialTriggerScheduleSlot(
  spec: Pick<TriggerScheduleSpec, 'type' | 'enabled' | 'cron' | 'runAt' | 'timezone'>,
  now: Date,
  options: { jitterKey?: string; jitterWindowMs?: number } = {},
): Date | null {
  return nextTriggerScheduleSlot(spec, now, { ...options, includePastOneOff: true });
}

export function advanceTriggerScheduleSlot(
  spec: Pick<TriggerScheduleSpec, 'type' | 'enabled' | 'cron' | 'runAt' | 'timezone'>,
  scheduledFor: Date,
  options: { jitterKey?: string; jitterWindowMs?: number } = {},
): Date | null {
  if (spec.runAt) return null;
  return nextTriggerScheduleSlot(spec, scheduledFor, options);
}
