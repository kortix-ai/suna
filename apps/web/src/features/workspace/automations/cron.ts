import { getEnv } from '@/lib/env-config';
import type { ProjectTrigger } from '@kortix/sdk';

/* ─── Cron presets ──────────────────────────────────────────────────────── */

export interface CronPreset {
  id: string;
  label: string;
  hint: string;
  /** 6-field croner expression (sec min hour day month weekday). */
  expr: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { id: '5m', label: 'Every 5 minutes', hint: 'Frequent polling', expr: '0 */5 * * * *' },
  { id: '15m', label: 'Every 15 minutes', hint: 'Modest polling', expr: '0 */15 * * * *' },
  { id: '1h', label: 'Hourly', hint: 'At the top of each hour', expr: '0 0 * * * *' },
  { id: 'daily', label: 'Daily at 09:00', hint: 'Once a day', expr: '0 0 9 * * *' },
  { id: 'wkdy', label: 'Weekdays at 09:00', hint: 'Mon–Fri morning', expr: '0 0 9 * * 1-5' },
  { id: 'wkly', label: 'Mondays at 09:00', hint: 'Once a week', expr: '0 0 9 * * 1' },
];

/** The expression the create flow starts from — "Daily at 09:00". */
export const DEFAULT_CRON_EXPR = '0 0 9 * * *';

export function describeCron(expr: string): string {
  const trimmed = expr.trim();
  const preset = CRON_PRESETS.find((p) => p.expr === trimmed);
  if (preset) return preset.label;

  // Fall back to a tiny pattern-match for the most common ad-hoc shapes so a
  // user-typed expression doesn't always read as raw cron syntax.
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 6) return trimmed;
  const [, min, hour, day, month, weekday] = parts;
  if (min.startsWith('*/') && hour === '*') {
    const n = min.slice(2);
    return `Every ${n} minute${n === '1' ? '' : 's'}`;
  }
  if (min === '0' && hour.startsWith('*/')) {
    const n = hour.slice(2);
    return `Every ${n} hour${n === '1' ? '' : 's'}`;
  }
  if (min !== '*' && hour !== '*' && day === '*' && month === '*') {
    const t = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (weekday === '*') return `Daily at ${t}`;
    if (weekday === '1-5') return `Weekdays at ${t}`;
    if (weekday === '0,6' || weekday === '6,0') return `Weekends at ${t}`;
    return `At ${t} on day ${weekday}`;
  }
  return trimmed;
}

/**
 * Which preset an expression corresponds to, or `null` when it is bespoke.
 * The preset-first UI shows the radio list; a `null` here is what forces the
 * raw-cron field open so a power user is never hidden from their own config.
 */
export function matchCronPreset(expr: string): CronPreset | null {
  const trimmed = expr.trim();
  return CRON_PRESETS.find((p) => p.expr === trimmed) ?? null;
}

/**
 * Build the 6-field expression for a daily run at `HH:MM`.
 *
 * Unparseable input falls back to {@link DEFAULT_CRON_EXPR} rather than to
 * midnight — a blank time field must not silently schedule work at 00:00.
 * Parseable but out-of-range values are clamped.
 */
export function dailyExprAt(time: string): string {
  const [rawHour, rawMin] = time.split(':');
  const parsedHour = Number.parseInt(rawHour ?? '', 10);
  const parsedMin = Number.parseInt(rawMin ?? '', 10);
  if (Number.isNaN(parsedHour) || Number.isNaN(parsedMin)) return DEFAULT_CRON_EXPR;
  const hour = Math.min(23, Math.max(0, parsedHour));
  const min = Math.min(59, Math.max(0, parsedMin));
  return `0 ${min} ${hour} * * *`;
}

/* ─── Trigger display ───────────────────────────────────────────────────── */

export function describeRunAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Runs once';
  return `Runs once on ${d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function getTriggerName(t: ProjectTrigger): string {
  if (t.name?.trim()) return t.name.trim();
  if (t.type === 'cron' && t.run_at) return describeRunAt(t.run_at);
  if (t.type === 'cron' && t.cron) return describeCron(t.cron);
  return t.type === 'webhook' ? 'Webhook trigger' : 'Cron trigger';
}

export function getTriggerSubtitle(t: ProjectTrigger): string {
  if (t.type === 'cron') return t.run_at ? 'One-off' : t.timezone;
  return t.secret_env ? `Signed via ${t.secret_env}` : 'Unsigned';
}

/** `now` is injectable so the relative buckets are testable without fake timers. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ─── Webhooks ──────────────────────────────────────────────────────────── */

export function buildWebhookUrl(triggerId: string): string {
  let backendUrl = '';
  try {
    backendUrl = getEnv().BACKEND_URL ?? '';
  } catch {
    /* no-op — fall back to placeholder below */
  }
  if (!backendUrl) return `[BACKEND_URL]/webhooks/${triggerId}`;
  return `${backendUrl.replace(/\/$/, '')}/webhooks/${triggerId}`;
}

export function buildCurlExample(url: string): string {
  // We deliberately keep the body small and the openssl invocation legible so
  // a user can copy-paste this once and have a working sample.
  return [
    `curl -X POST ${url} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Kortix-Signature: sha256=$(echo -n '$BODY' | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')" \\`,
    `  -d '$BODY'`,
    ``,
    `# Where:`,
    `#   BODY    = '{"event":"deploy.succeeded","ref":"main"}'`,
    `#   SECRET  = the signing secret you set when creating this trigger`,
  ].join('\n');
}

/** Cryptographically random hex string (32 bytes of entropy). */
export function generateSecret(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** project_secrets keys are UPPER_SNAKE_CASE — mirror the API's own validation
 *  so a typed name can't 400 on save. Empty in, empty out. */
export function normalizeSecretEnvName(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
}

export function slugifyName(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 128) || 'trigger'
  );
}

/* ─── Session strategy ──────────────────────────────────────────────────── */

export type SessionMode = ProjectTrigger['session_mode'];

export const SESSION_MODES: readonly SessionMode[] = ['fresh', 'reuse', 'pinned', 'keyed'];

/** Deliberately plain-language — the manifest calls the last one "keyed", but
 *  nobody configuring a webhook thinks in those terms. */
export const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  fresh: 'New session each run',
  reuse: "Reuse this trigger's session (loop)",
  pinned: 'Pin a specific session…',
  keyed: 'One session per conversation',
};

export const SESSION_MODE_HELP =
  'Fresh mints a new session each run; reuse loops this trigger’s own session; pinned loops one specific session you choose; one-per-conversation routes each value below to its own session.';

export const SESSION_KEY_PLACEHOLDER = '{{ body.data.chat_jid }}';

/** Read-only summary of a trigger's session strategy (the no-write view). */
export function describeSessionStrategy(trigger: ProjectTrigger): string {
  const base = SESSION_MODE_LABEL[trigger.session_mode];
  if (trigger.session_mode === 'pinned' && trigger.session_id) {
    return `${base} · ${trigger.session_id.slice(0, 8)}`;
  }
  if (trigger.session_mode === 'keyed' && trigger.session_key) {
    return `${base} · ${trigger.session_key}`;
  }
  return base;
}

/* ─── Delivery filters ──────────────────────────────────────────────────── */

export interface FilterRow {
  path: string;
  value: string;
}

export function filterToRows(filter: Record<string, string> | null | undefined): FilterRow[] {
  return Object.entries(filter ?? {}).map(([path, value]) => ({ path, value }));
}

/** Drop blank paths and collapse to the wire shape. `null` means "unfiltered". */
export function rowsToFilter(rows: FilterRow[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const path = row.path.trim();
    if (!path) continue;
    out[path] = row.value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function sameFilter(
  a: Record<string, string> | null,
  b: Record<string, string> | null | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => left[k] === right[k]);
}

/* ─── Timezones ─────────────────────────────────────────────────────────── */

export const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];
