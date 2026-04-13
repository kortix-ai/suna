'use client';

/**
 * Status dropdown pill — used across the task tracker.
 * Trigger uses the shadcn Button (no inline-styled buttons).
 */

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STATUS_META, ALL_STATUSES } from '@/lib/kortix/task-meta';
import type { KortixTaskStatus } from '@/hooks/kortix/use-kortix-tasks';

interface StatusPillProps {
  status: KortixTaskStatus;
  onChange: (status: KortixTaskStatus) => void;
  variant?: 'pill' | 'icon';
  align?: 'start' | 'end';
  className?: string;
  /** Extra className for DropdownMenuContent (e.g. z-index override inside dialogs) */
  contentClassName?: string;
}

export function StatusPill({
  status,
  onChange,
  variant = 'pill',
  align = 'start',
  className,
  contentClassName,
}: StatusPillProps) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'icon' ? (
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-6 w-6 rounded-md', className)}
            onClick={(e) => e.stopPropagation()}
            title={meta.label}
          >
            <Icon className={cn('h-4 w-4', meta.color)} />
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className={cn('h-7 px-2.5 text-xs gap-1.5 font-medium', className)}
          >
            <Icon className={cn('h-3.5 w-3.5', meta.color)} />
            {meta.label}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn('w-44', contentClassName)}>
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
          Status
        </DropdownMenuLabel>
        {ALL_STATUSES.filter((s) => s !== 'in_progress').map((s) => {
          const M = STATUS_META[s];
          const I = M.icon;
          return (
            <DropdownMenuItem key={s} onClick={() => onChange(s)}>
              <I className={cn('h-3.5 w-3.5 mr-2', M.color)} />
              {M.label}
              {status === s && <Check className="h-3 w-3 ml-auto" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
