'use client';

import { getManagedModel } from '@kortix/llm-catalog';
import { CheckIcon as Check, CopyIcon as Copy } from '@phosphor-icons/react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

// One brand accent for the whole surface (Kortix is monochrome + a single
// accent). Per-model rainbow coloring was the "yellow-brown" noise — gone.
export const ACCENT = 'var(--kortix-blue)';

export function modelAccent(_id: string): string {
  return ACCENT;
}

export function modelLabel(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function displayModel(id: string): string {
  return getManagedModel(id)?.name ?? id.split('/').pop() ?? id;
}

export function tint(accent: string, pct: number): string {
  return `color-mix(in oklch, ${accent} ${pct}%, transparent)`;
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label="Copy"
      className={cn(
        'text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-150',
        className,
      )}
    >
      {copied ? <Check className="text-kortix-green size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/**
 * The gateway surface's one panel shell — `bg-popover rounded-md border`
 * (replaces the deprecated SectionCard). Header carries title / count /
 * description / action; padding lives on the inner sections, never on the
 * bordered shell.
 *
 * It was copy-pasted verbatim into `gateway-overview.tsx` and
 * `gateway-budgets.tsx`. Budgets is now a section INSIDE Overview, so the two
 * copies would sit inches apart on one screen and drift into two slightly
 * different panels. One definition, here.
 */
export function Panel({
  title,
  count,
  description,
  action,
  children,
}: {
  title: React.ReactNode;
  count?: number;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-popover overflow-hidden rounded-md border">
      <div className="border-border/60 flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-foreground text-sm font-medium">
            {title}
            {count != null && <span className="text-muted-foreground font-normal"> ({count})</span>}
          </h3>
          {description != null && (
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
          )}
        </div>
        {action != null && <div className="shrink-0">{action}</div>}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

export function MetricBar({
  icon: Icon,
  value,
  pct,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  pct: number;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="text-muted-foreground size-3 shrink-0" />
      <div className="bg-primary/[0.06] h-1.5 flex-1 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(3, Math.min(100, pct))}%`, backgroundColor: accent }}
        />
      </div>
      <span className="text-muted-foreground w-20 shrink-0 text-right text-xs tabular-nums">
        {value}
      </span>
    </div>
  );
}
