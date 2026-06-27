'use client';

import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'icon';
};

export function Button({ className, variant = 'default', size = 'md', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60',
        variant === 'default' &&
          'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90',
        variant === 'outline' &&
          'border border-[var(--color-border)] bg-transparent text-[var(--color-fg)] hover:bg-[var(--color-panel-2)]',
        variant === 'ghost' && 'bg-transparent text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-fg)]',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'icon' && 'h-9 w-9',
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]', className)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60',
        className,
      )}
      {...props}
    />
  );
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-muted)]',
        className,
      )}
      {...props}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-[var(--color-muted)]', className)} />;
}
