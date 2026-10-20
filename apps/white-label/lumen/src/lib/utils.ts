/** A short, human-friendly relative time ("2m ago"). */
export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

/** A locale date string, or `fallback` when the value is absent or not a date. */
export function fmtDate(value: unknown, fallback = ''): string {
  if (!value) return fallback;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? fallback : d.toLocaleString();
}

/** A Convex error as a person reads it: "403: admins only" → "admins only". */
export function errorText(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  const m = /\b\d{3}: (.*?)(?:\n|$)/.exec(msg);
  const text = m ? m[1] : msg;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
