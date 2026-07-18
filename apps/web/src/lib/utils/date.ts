export { fullDate, relativeTime } from '@/lib/kortix/task-meta';

export function formatDate(t?: string | number | Date | null): string {
  if (!t) return '';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(t?: string | number | Date | null): string {
  if (!t) return '';
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
