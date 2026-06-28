/**
 * Single source of truth for task status & priority presentation.
 *
 * Mirrors the canonical task statuses exposed by the live /kortix/tasks API.
 */

import {
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { KortixTaskStatus } from '@/hooks/kortix/use-kortix-tasks';

export interface StatusMeta {
  icon: LucideIcon;
  color: string;
  bg: string;
  border: string;
  label: string;
  /** Display order for grouping/columns */
  order: number;
  /** True for "open / active" — used for stats */
  active?: boolean;
  /** True for done-like terminal states */
  terminal?: boolean;
}

export const STATUS_META: Record<KortixTaskStatus, StatusMeta> = {
  todo: {
    icon: Circle,
    color: 'text-muted-foreground/70',
    bg: 'bg-muted/30',
    border: 'border-border',
    label: 'Planned',
    order: 0,
  },
  in_progress: {
    icon: CircleDot,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    label: 'Running',
    order: 1,
    active: true,
  },
  input_needed: {
    icon: CircleDotDashed,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/30',
    label: 'Input Needed',
    order: 2,
    active: true,
  },
  awaiting_review: {
    icon: CircleDotDashed,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    label: 'Awaiting Review',
    order: 3,
    active: true,
  },
  completed: {
    icon: CheckCircle2,
    color: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    label: 'Completed',
    order: 4,
    terminal: true,
  },
  cancelled: {
    icon: XCircle,
    color: 'text-muted-foreground/40',
    bg: 'bg-muted/20',
    border: 'border-border',
    label: 'Cancelled',
    order: 5,
    terminal: true,
  },
};

/** All statuses in pipeline order. */
export const ALL_STATUSES: KortixTaskStatus[] = [
  'todo',
  'in_progress',
  'input_needed',
  'awaiting_review',
  'completed',
  'cancelled',
];

/** Linear-style short ID — KTX-XXXX from the trailing chars of the task id. */
export function shortTaskId(id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
  return `KTX-${tail || '0000'}`;
}

export function relativeTime(t?: string | number | null): string {
  if (!t) return '';
  const ms = Date.now() - (typeof t === 'string' ? +new Date(t) : t);
  const m = (ms / 60000) | 0;
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = (m / 60) | 0;
  if (h < 24) return `${h}h ago`;
  const d = (h / 24) | 0;
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fullDate(t?: string | null): string {
  if (!t) return '';
  return new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
