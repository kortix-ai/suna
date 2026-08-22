const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const d = new Date(then);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function projectToRow(
  p: { project_id: string; name: string; updated_at: string },
  now: number = Date.now(),
): { id: string; title: string; subtitle: string } {
  return { id: p.project_id, title: p.name, subtitle: `Updated ${formatRelativeTime(p.updated_at, now)}` };
}
