import type { ComponentType, ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface EmptyStateProps {
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  hint?: ReactNode;
  align?: 'left' | 'center';
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
  hint,
  align = 'center',
  size = 'md',
  className,
}: EmptyStateProps) {
  const centered = align === 'center';
  return (
    <div
      className={cn(
        'flex flex-col rounded-2xl border border-border/40 bg-muted/50',
        size === 'sm' ? 'gap-3 px-6 py-10' : 'gap-5 px-8 py-16 md:py-24',
        centered ? 'items-center text-center' : 'items-start',
        className,
      )}
    >
      {Icon ? (
        <span
          className={cn(
            'flex items-center justify-center rounded-full text-foreground/65',
            size === 'sm' ? 'size-10' : 'size-12',
          )}
        >
          <Icon className={size === 'sm' ? 'size-4' : 'size-5'} strokeWidth={1.5} />
        </span>
      ) : null}

      {eyebrow ? (
        <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground/70">
          {eyebrow}
        </span>
      ) : null}

      <div className={cn('grid gap-2', centered ? 'items-center' : '')}>
        <h3
          className={cn(
            'font-sans tracking-tight text-foreground font-medium text-lg',
            // size === 'sm' ? 'text-xl leading-tight' : 'text-2xl leading-[1.15] md:text-3xl',
          )}
        >
          {title}
        </h3>
        {description ? (
          <p
            className={cn(
              'text-sm leading-relaxed text-muted-foreground',
              centered ? 'mx-auto max-w-md' : 'max-w-md',
            )}
          >
            {description}
          </p>
        ) : null}
      </div>

      {actions ? (
        <div
          className={cn('flex flex-wrap items-center gap-2 pt-2', centered ? 'justify-center' : '')}
        >
          {actions}
        </div>
      ) : null}

      {hint ? (
        <div className="pt-1 font-mono text-[0.62rem] uppercase tracking-widest text-muted-foreground/60">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
