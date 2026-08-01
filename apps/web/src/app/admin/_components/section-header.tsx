'use client';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { cn } from '@/lib/utils';
import type { Icon as LucideIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export function SectionHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="border-border/60 flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <EntityAvatar icon={Icon} size="lg" className="hidden sm:inline-flex" />
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface StatPillProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}

const TONE_STYLES: Record<NonNullable<StatPillProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  info: 'text-blue-600 dark:text-blue-400',
};

export function StatPill({ label, value, hint, tone = 'default', className }: StatPillProps) {
  return (
    <div className={cn('border-border/60 bg-card min-w-0 rounded-2xl border p-4', className)}>
      <div className="text-muted-foreground/70 text-xs font-medium tracking-wider uppercase">
        {label}
      </div>
      <div className={cn('mt-1 truncate text-2xl font-semibold tracking-tight', TONE_STYLES[tone])}>
        {value}
      </div>
      {hint && <div className="text-muted-foreground mt-0.5 truncate text-xs">{hint}</div>}
    </div>
  );
}

export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>
  );
}

export function SectionContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-8', className)}>
      {children}
    </div>
  );
}
