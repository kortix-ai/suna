/**
 * Trigger formatting helpers shared by the Schedules and Webhooks pages.
 * Pure functions — no React. Mirrors the web triggers-view describe/slugify.
 */

export interface CronPreset {
  cron: string;
  label: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { cron: '0 */5 * * * *', label: 'Every 5 minutes' },
  { cron: '0 */15 * * * *', label: 'Every 15 minutes' },
  { cron: '0 0 * * * *', label: 'Hourly' },
  { cron: '0 0 9 * * *', label: 'Daily at 9:00' },
  { cron: '0 0 9 * * 1-5', label: 'Weekdays at 9:00' },
  { cron: '0 0 9 * * 1', label: 'Mondays at 9:00' },
];

export const DEFAULT_CRON = '0 0 9 * * *';

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

/** kortix.toml-style slug: lowercase, [a-z0-9_-], trimmed, ≤128, fallback. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return s || 'trigger';
}

export function describeCron(cron: string | null): string {
  if (!cron) return 'Custom schedule';
  const preset = CRON_PRESETS.find((p) => p.cron === cron);
  return preset ? preset.label : cron;
}

export function describeRunAt(runAt: string | null): string {
  if (!runAt) return 'One-off';
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) return 'One-off';
  return `Once · ${d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function humanize(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/** "2h ago" / "in 3h" / "Never". */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Never';
  const diff = Date.now() - t;
  if (diff < 0) return `in ${humanize(-diff)}`;
  if (diff < 60_000) return 'just now';
  return `${humanize(diff)} ago`;
}

export interface RunAtPreset {
  label: string;
  /** ms offset from now. */
  offset: number;
}

export const RUN_AT_PRESETS: RunAtPreset[] = [
  { label: 'In 1 hour', offset: 60 * 60 * 1000 },
  { label: 'In 3 hours', offset: 3 * 60 * 60 * 1000 },
  { label: 'In 12 hours', offset: 12 * 60 * 60 * 1000 },
  { label: 'In 24 hours', offset: 24 * 60 * 60 * 1000 },
];
