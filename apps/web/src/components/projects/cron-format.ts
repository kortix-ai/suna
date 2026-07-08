/**
 * Cron / trigger display formatters. Mirrors the local helpers in
 * schedule-view.tsx (the folder auto-pages reuse them). Kept framework-free.
 */

interface CronPreset {
  label: string;
  /** 6-field croner expression (sec min hour day month weekday). */
  expr: string;
}

const CRON_PRESETS: readonly CronPreset[] = [
  { label: 'Every 5 minutes', expr: '0 */5 * * * *' },
  { label: 'Every 15 minutes', expr: '0 */15 * * * *' },
  { label: 'Hourly', expr: '0 0 * * * *' },
  { label: 'Daily at 09:00', expr: '0 0 9 * * *' },
  { label: 'Weekdays at 09:00', expr: '0 0 9 * * 1-5' },
  { label: 'Mondays at 09:00', expr: '0 0 9 * * 1' },
];

/** Humanize a 6-field croner expression, or return it unchanged. */
export function describeCron(expr: string): string {
  const trimmed = expr.trim();
  const preset = CRON_PRESETS.find((p) => p.expr === trimmed);
  if (preset) return preset.label;

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

/** Humanize a one-off ISO run-at instant. */
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

/** Compact "Nm ago" / "never" relative time for a last-fired instant. */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
