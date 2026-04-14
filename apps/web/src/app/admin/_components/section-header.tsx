'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

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
    <div className="flex flex-col gap-3 border-b border-border/60 pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3 min-w-0">
        <div className="hidden sm:flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
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
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card p-4 min-w-0',
        className,
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      <div className={cn('mt-1 text-2xl font-semibold tracking-tight truncate', TONE_STYLES[tone])}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground truncate">{hint}</div>}
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
    <div className={cn('mx-auto w-full max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6', className)}>
      {children}
    </div>
  );
}
