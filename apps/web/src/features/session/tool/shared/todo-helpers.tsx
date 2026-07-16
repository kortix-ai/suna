'use client';

import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { BanSolid, CheckCircleSolid } from '@mynaui/icons-react';

export interface TodoItem {
  content: string;
  status: 'completed' | 'in_progress' | 'pending' | 'cancelled';
  priority?: string;
}

export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const content = (raw as any).content;
    if (typeof content !== 'string' || !content.trim()) return [];
    const s = (raw as any).status;
    const status: TodoItem['status'] =
      s === 'completed' || s === 'in_progress' || s === 'cancelled' ? s : 'pending';
    return [{ content, status, priority: (raw as any).priority }];
  });
}

export function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircleSolid className="text-kortix-green size-4 shrink-0" />;
    case 'in_progress':
      return <Loading className="text-kortix-orange size-4 shrink-0" />;
    case 'cancelled':
      return <BanSolid className="text-muted-foreground/40 size-4 shrink-0" />;
    case 'pending':
      return (
        <div className="flex size-4 shrink-0 items-center justify-center">
          <svg
            height="16"
            viewBox="0 0 16 16"
            width="16"
            strokeLinejoin="round"
            className={cn(
              'text-muted-foreground relative flex shrink-0 items-center justify-center',
            )}
          >
            <circle
              cx="8"
              cy="8"
              r="6.3"
              stroke="currentColor"
              fill="none"
              strokeWidth="1.5"
              strokeDasharray="3 3.4"
            ></circle>
          </svg>
        </div>
      );
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
