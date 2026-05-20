import * as React from 'react';
import { cn } from '../../lib/utils';
import { User } from 'lucide-react';

export type PageEyebrowTone = 'neutral' | 'success' | 'warn' | 'danger' | 'muted';

const TONE_DOT: Record<PageEyebrowTone, string> = {
  neutral: 'bg-foreground/80',
  success: 'bg-emerald-400',
  warn: 'bg-amber-300',
  danger: 'bg-rose-400',
  muted: 'bg-muted-foreground/60',
};

export interface PageHeaderProps {
  eyebrow?: React.ReactNode;
  eyebrowTone?: PageEyebrowTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}

export function PageHeader({
  eyebrow,
  eyebrowTone = 'neutral',
  title,
  description,
  meta,
  actions,
  className,
  icon,
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn('mb-4 flex flex-wrap items-end justify-between gap-6', className)}
    >
      <div className="grid min-w-0">
        {eyebrow ? (
          <div className="mb-2 flex items-center gap-2 font-mono text-[0.62rem] uppercase tracking-[0.2em] text-muted-foreground/80">
            <span className={cn('size-1 rounded-full', TONE_DOT[eyebrowTone])} aria-hidden />
            <span>{eyebrow}</span>
          </div>
        ) : null}
        <div className="mb-1 flex items-center gap-2">
          <h1 className="font-sans text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-2xl">
            {title}
          </h1>
          {icon ? <div className="size-6">{icon}</div> : null}
        </div>
        {description ? (
          <div className="mb-2 max-w-2xl font-sans text-md leading-relaxed text-muted-foreground">
            {description}
          </div>
        ) : null}
        {meta ? <div className="pt-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
