'use client';

import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Label } from '@/components/ui/label';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { cn } from '@/lib/utils';

/**
 * The row grammar of "Your computer": every capability, layer, permission and
 * setting is one row (tile, title, one muted line, one trailing control), and
 * rows sit in flat titled sections. No box inside the dialog's box.
 */
export function ComputerSection({
  title,
  action,
  hint,
  children,
}: {
  title: string;
  /** One control beside the title, e.g. the permission step's "Allow access". */
  action?: ReactNode;
  /** One muted line below the rows. */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <Label>{title}</Label>
        {action}
      </div>
      <ul className="divide-border divide-y">{children}</ul>
      {hint ? <p className="text-muted-foreground pt-1 text-xs text-pretty">{hint}</p> : null}
    </section>
  );
}

export function ComputerRow({
  icon: RowIcon,
  title,
  description,
  trailing,
  muted = false,
}: {
  icon: Icon;
  title: string;
  description?: ReactNode;
  trailing?: ReactNode;
  /** Unavailable here (a layer the project turned off): the row reads quieter. */
  muted?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
        <RowIcon className="size-4" />
      </span>
      <div className={cn('min-w-0 flex-1 space-y-0.5', muted && 'opacity-60')}>
        <p className="text-sm">{title}</p>
        {description ? <p className="text-muted-foreground truncate text-xs">{description}</p> : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center">{trailing}</div> : null}
    </li>
  );
}

/** A grant's state at the end of a row: a green check when allowed, a muted word otherwise. */
export function GrantState({ allowed, label }: { allowed: boolean; label: string }) {
  return (
    <span className={cn('flex items-center gap-1 text-xs', allowed ? 'text-foreground' : 'text-muted-foreground')}>
      {allowed ? <SolidCheckIcon className="text-kortix-green size-3.5" /> : null}
      {label}
    </span>
  );
}

/** The status dot of the header and the tabs. */
export type StatusTone = 'good' | 'attention' | 'bad' | 'idle';
const TONE: Record<StatusTone, string> = {
  good: 'bg-kortix-green',
  attention: 'bg-kortix-orange',
  bad: 'bg-kortix-red',
  idle: 'bg-muted-foreground',
};
export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', TONE[tone])} />;
}
