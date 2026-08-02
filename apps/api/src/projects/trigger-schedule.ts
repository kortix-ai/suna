import { createHash } from 'node:crypto';
import { Cron } from 'croner';

export interface TriggerScheduleSpec {
  slug: string;
  type: 'cron' | 'webhook';
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
}

export function validateTriggerTimezone(timezone: string): string | null {
  const normalized = timezone.trim();
  if (!normalized) return 'timezone must not be empty';
  if (normalized !== 'UTC' && !normalized.includes('/')) {
    return `timezone must be a valid IANA name like "UTC" or "America/Los_Angeles" (got "${timezone}")`;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized });
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
  };
  return createHash('sha256').update(JSON.stringify(scheduleConfig)).digest('hex');
}

export function nextTriggerScheduleSlot(
  spec: Pick<TriggerScheduleSpec, 'type' | 'enabled' | 'cron' | 'runAt' | 'timezone'>,
  after: Date,
  options: { includePastOneOff?: boolean } = {},
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
  return cron.nextRun(after);
}

export function initialTriggerScheduleSlot(
  spec: Pick<TriggerScheduleSpec, 'type' | 'enabled' | 'cron' | 'runAt' | 'timezone'>,
  now: Date,
): Date | null {
  return nextTriggerScheduleSlot(spec, now, { includePastOneOff: true });
}

export function advanceTriggerScheduleSlot(
  spec: Pick<TriggerScheduleSpec, 'type' | 'enabled' | 'cron' | 'runAt' | 'timezone'>,
  scheduledFor: Date,
): Date | null {
  if (spec.runAt) return null;
  return nextTriggerScheduleSlot(spec, scheduledFor);
}
