'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { favicon } from './data';

export function PageHead({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-foreground text-lg font-semibold tracking-tight">{title}</h3>
        {sub && <p className="text-muted-foreground mt-0.5 text-sm">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Panel({
  title,
  count,
  action,
  children,
  className,
}: {
  title?: string;
  count?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-md border', className)}>
      {title && (
        <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-foreground text-sm font-semibold">
            {title}
            {count && <span className="text-muted-foreground ml-1.5 font-normal">{count}</span>}
          </span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Row({
  leading,
  title,
  subtitle,
  trailing,
  onClick,
}: {
  leading: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      className={cn(
        'border-border flex items-center gap-3 border-b px-4 py-3 last:border-0',
        onClick && 'hover:bg-muted/40 cursor-pointer transition-colors',
      )}
    >
      <span className="shrink-0">{leading}</span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="text-muted-foreground truncate text-xs">{subtitle}</div>}
      </div>
      {trailing}
    </div>
  );
}

/** Real brand logo (favicon) on a neutral tile — used for Integrations + Models. */
export function BrandLogo({
  domain,
  alt,
  size = 20,
}: {
  domain: string;
  alt: string;
  size?: number;
}) {
  return (
    <span
      className="border-border bg-background flex shrink-0 items-center justify-center overflow-hidden rounded-lg border"
      style={{ width: size + 12, height: size + 12 }}
    >
      <img
        src={favicon(domain)}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        // className="rounded-sm"
        style={{ width: size, height: size }}
      />
    </span>
  );
}

export function StatusDot({ on, label }: { on: boolean; label?: [string, string] }) {
  const [onText, offText] = label ?? ['running', 'scheduled'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        on ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          on ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/30',
        )}
      />
      {on ? onText : offText}
    </span>
  );
}

export function Toggle({ on, onClick }: { on: boolean; onClick?: () => void }) {
  const className = cn(
    'flex h-5 w-9 items-center rounded-full p-0.5 transition-colors',
    on ? 'bg-kortix-green justify-end' : 'bg-muted-foreground/20 justify-start',
    onClick && 'cursor-pointer',
  );
  const knob = <span className="size-4 rounded-full bg-white shadow" />;
  if (!onClick) return <span className={className}>{knob}</span>;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Toggle schedule"
      onClick={onClick}
      className={className}
    >
      {knob}
    </button>
  );
}

export function ConnectBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge size="sm" variant="success" className="ml-auto shrink-0 gap-1">
      <span className="size-1.5 rounded-full bg-emerald-500" /> Connected
    </Badge>
  ) : (
    <Badge size="sm" variant="outline" className="ml-auto shrink-0">
      Connect
    </Badge>
  );
}

export function SendGlyph({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
    </svg>
  );
}
