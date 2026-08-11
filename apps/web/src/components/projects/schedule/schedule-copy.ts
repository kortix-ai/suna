/**
 * Plain-language copy for schedules and webhooks.
 *
 * Everything a person reads on the Schedules and Webhooks screens is built
 * here, so the two screens can never drift and so the wording can be tested
 * without rendering anything. The rule: **the UI never shows the wire word.**
 * A cron expression reads as "Every day at 09:00", `session_mode: 'keyed'`
 * reads as "One session per conversation", and `secret_env` reads as "Signed".
 *
 * Where a value genuinely has no plain equivalent — a hand-written cron
 * expression, the trigger id, the file it is saved in — the plain summary
 * wins in the list and the exact value stays available under Advanced or
 * Details. Hiding it entirely would be dishonest; leading with it is what
 * made these screens read as a config file.
 */

import type { ProjectTrigger } from '@kortix/sdk';

export type TriggerKind = 'cron' | 'webhook';

/* ─── Time of day ───────────────────────────────────────────────────────── */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function timeOfDay(hour: string, minute: string): string | null {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ordinal(value: number): string {
  if (value >= 11 && value <= 13) return `${value}th`;
  const suffix = value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th';
  return `${value}${suffix}`;
}

/** `1-5` and `1,2,3,4,5` both mean the same set of days. */
function parseWeekdays(field: string): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to || to > 6) return null;
      for (let d = from; d <= to; d += 1) out.add(d);
      continue;
    }
    if (!/^\d$/.test(part)) return null;
    const day = Number(part);
    if (day > 6) return null;
    // Cron accepts 7 for Sunday in some dialects; croner uses 0-6 only.
    out.add(day);
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null;
}

function describeWeekdays(days: number[], time: string): string {
  const key = days.join(',');
  if (key === '1,2,3,4,5') return `Weekdays at ${time}`;
  if (key === '0,6') return `Weekends at ${time}`;
  if (days.length === 7) return `Every day at ${time}`;
  if (days.length === 1) return `Every ${DAY_NAMES[days[0]]} at ${time}`;
  return `${days.map((d) => DAY_SHORT[d]).join(', ')} at ${time}`;
}

/** Shown when an expression is valid cron but has no plain-English shape. */
export const CUSTOM_TIMING_LABEL = 'Custom timing';

/**
 * A 6-field cron expression as a sentence a person can check at a glance.
 * Covers every shape the schedule picker can produce, plus the common
 * hand-written ones. Anything else falls back to {@link CUSTOM_TIMING_LABEL} —
 * the raw expression is still shown under Advanced, never in the list.
 */
export function describeCadence(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 6) return CUSTOM_TIMING_LABEL;
  const [, minute, hour, day, month, weekday] = parts;

  // Every N minutes.
  if (minute.startsWith('*/') && hour === '*' && day === '*' && weekday === '*') {
    const n = Number(minute.slice(2));
    if (!Number.isInteger(n) || n < 1) return CUSTOM_TIMING_LABEL;
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // Every N hours, on a given minute.
  if (hour.startsWith('*/') && day === '*' && weekday === '*') {
    const n = Number(hour.slice(2));
    const m = Number(minute);
    if (!Number.isInteger(n) || n < 1 || !Number.isInteger(m)) return CUSTOM_TIMING_LABEL;
    const at = `:${pad2(m)}`;
    return n === 1 ? `Every hour at ${at}` : `Every ${n} hours at ${at}`;
  }

  // Every hour, on the hour.
  if (hour === '*' && day === '*' && weekday === '*' && /^\d+$/.test(minute)) {
    return `Every hour at :${pad2(Number(minute))}`;
  }

  const time = timeOfDay(hour, minute);
  if (!time || month !== '*') return CUSTOM_TIMING_LABEL;

  // A given day of the month.
  if (/^\d+$/.test(day) && weekday === '*') {
    const dayOfMonth = Number(day);
    if (dayOfMonth < 1 || dayOfMonth > 31) return CUSTOM_TIMING_LABEL;
    return `The ${ordinal(dayOfMonth)} of each month at ${time}`;
  }

  if (day !== '*') return CUSTOM_TIMING_LABEL;

  // Every day.
  if (weekday === '*') return `Every day at ${time}`;

  // Specific weekdays.
  const days = parseWeekdays(weekday);
  return days ? describeWeekdays(days, time) : CUSTOM_TIMING_LABEL;
}

/** A one-off run as a date a person can read. */
export function describeOneOff(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Runs once';
  return `Once on ${date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * The one line that answers "when does this run?" — the same sentence in the
 * list, the detail panel, and the delete confirmation.
 */
export function describeWhen(trigger: ProjectTrigger): string {
  if (trigger.type === 'webhook') return 'When a request arrives';
  if (trigger.run_at) return describeOneOff(trigger.run_at);
  if (trigger.cron) return describeCadence(trigger.cron);
  return CUSTOM_TIMING_LABEL;
}

/* ─── Names ─────────────────────────────────────────────────────────────── */

/** Never blank: falls back to what the automation does, then to its kind. */
export function triggerName(trigger: ProjectTrigger): string {
  const named = trigger.name?.trim();
  if (named) return named;
  if (trigger.type === 'cron') return describeWhen(trigger);
  return 'Untitled webhook';
}

/* ─── Status ────────────────────────────────────────────────────────────── */

export type TriggerStatus = {
  label: 'Active' | 'Paused';
  active: boolean;
  /** Tint classes for the leading icon tile. */
  tileClassName: string;
  iconClassName: string;
};

export function triggerStatus(enabled: boolean): TriggerStatus {
  return enabled
    ? {
        label: 'Active',
        active: true,
        tileClassName: 'bg-kortix-green/10',
        iconClassName: 'text-kortix-green',
      }
    : {
        label: 'Paused',
        active: false,
        tileClassName: 'bg-muted',
        iconClassName: 'text-muted-foreground',
      };
}

/* ─── Last run ──────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * "Never", "Just now", "12 minutes ago", "3 hours ago", "5 days ago", then an
 * absolute date. `now` is a parameter so this is testable without faking time.
 */
export function describeLastRun(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never';

  const elapsed = now - then;
  if (elapsed < 0) return 'Just now';
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 30 * DAY) return plural(Math.floor(elapsed / DAY), 'day');
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/* ─── Where the run happens (session_mode) ──────────────────────────────── */

export type SessionMode = ProjectTrigger['session_mode'];

export const SESSION_MODES: readonly SessionMode[] = ['fresh', 'reuse', 'pinned', 'keyed'];

/** The wire calls the last one "keyed". Nobody setting up a webhook does. */
export const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  fresh: 'Start a new session every time',
  reuse: 'Keep using the same session',
  pinned: 'Always use one session I pick',
  keyed: 'One session per conversation',
};

export const SESSION_MODE_HELP: Record<SessionMode, string> = {
  fresh: 'Every run starts clean, with no memory of the last one.',
  reuse: 'Every run continues the same conversation, so the agent keeps its context.',
  pinned: 'Every run continues one session you choose below.',
  keyed:
    'Each sender or chat gets its own session, so separate conversations never blend together.',
};

/** One-line summary for read-only views and the list. */
export function describeRunLocation(trigger: ProjectTrigger): string {
  const base = SESSION_MODE_LABEL[trigger.session_mode];
  if (trigger.session_mode === 'pinned' && trigger.session_id) {
    return `${base} (${trigger.session_id.slice(0, 8)})`;
  }
  if (trigger.session_mode === 'keyed' && trigger.session_key) {
    return `${base} — by ${trigger.session_key}`;
  }
  return base;
}

/* ─── Webhook security ──────────────────────────────────────────────────── */

export type SecurityState = {
  label: 'Signed' | 'Not signed';
  signed: boolean;
  /** Sentence for the detail panel. */
  detail: string;
};

export function describeSecurity(trigger: ProjectTrigger): SecurityState {
  if (trigger.secret_env) {
    return {
      label: 'Signed',
      signed: true,
      detail: `Requests are checked against the saved secret ${trigger.secret_env}.`,
    };
  }
  return {
    label: 'Not signed',
    signed: false,
    detail: 'Anyone with this address can start a run. Add a signing key to lock it down.',
  };
}

/* ─── Conditions (the wire calls this `filter`) ─────────────────────────── */

/** "Runs on every request" / "Runs when 2 things match". */
export function describeConditions(filter: Record<string, string> | null | undefined): string {
  const count = Object.keys(filter ?? {}).length;
  if (count === 0) return 'Runs on every request';
  return count === 1 ? 'Runs when 1 condition matches' : `Runs when ${count} conditions match`;
}

/* ─── Per-kind screen copy ──────────────────────────────────────────────── */

export interface KindCopy {
  /** Section title. */
  title: string;
  /** Section description. */
  description: string;
  /** Singular noun, lowercase, for inline sentences. */
  noun: string;
  createLabel: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyBody: string;
  /** Header for the type-specific list column. */
  column: string;
}

export const KIND_COPY: Record<TriggerKind, KindCopy> = {
  cron: {
    title: 'Schedules',
    description: 'Have an agent do something on a repeating schedule, or once at a set time.',
    noun: 'schedule',
    createLabel: 'New schedule',
    searchPlaceholder: 'Search schedules',
    emptyTitle: 'No schedules yet',
    emptyBody: 'Create one to have an agent run on its own, on a schedule you set.',
    column: 'Runs',
  },
  webhook: {
    title: 'Webhooks',
    description: 'Give another app a private address that starts an agent when it sends a request.',
    noun: 'webhook',
    createLabel: 'New webhook',
    searchPlaceholder: 'Search webhooks',
    emptyTitle: 'No webhooks yet',
    emptyBody: 'Create one to let another app start an agent when something happens over there.',
    column: 'Security',
  },
};

/* ─── Search ────────────────────────────────────────────────────────────── */

/** Matches what a person can see in the list, not the wire fields. */
export function matchesQuery(trigger: ProjectTrigger, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    triggerName(trigger),
    trigger.agent,
    describeWhen(trigger),
    trigger.slug,
    triggerStatus(trigger.enabled).label,
  ].some((field) => field.toLowerCase().includes(q));
}
