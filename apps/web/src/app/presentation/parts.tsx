'use client';

/**
 * Presentation building blocks — a 1:1 mirror of the marketing homepage idiom
 * (apps/web home sections). Same vocabulary everywhere: mono-uppercase eyebrows,
 * `text-3xl/4xl font-medium tracking-tight` titles, `rounded-sm` thin-border
 * panels on `bg-card`, `font-medium` body weight, `KortixAsterisk` bullets, and
 * the marketing `Button`/`Badge`. Slides are responsive full-viewport sections
 * (like a homepage section), theme-following — never a forced palette.
 */

import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/* ── Slide frame: one full-viewport homepage-style section ─────────────── */

export function Slide({
  children,
  className,
  innerClassName,
  align = 'center',
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={cn(
        'relative flex h-full min-h-full w-full overflow-y-auto',
        align === 'center' ? 'items-center' : 'items-start',
        className,
      )}
    >
      <div
        className={cn(
          'mx-auto w-full max-w-6xl px-6 py-24 sm:py-28 lg:px-0',
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* ── Section header (eyebrow + title + lead), exactly like home sections ── */

export function SectionHead({
  eyebrow,
  title,
  lead,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('max-w-2xl space-y-3', className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">{title}</h2>
      {lead ? <p className="text-muted-foreground text-base leading-relaxed">{lead}</p> : null}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-muted-foreground font-mono text-xs tracking-wider uppercase',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Accent-weighted word inside a title (muted, matches home's secondary tone). */
export function Dim({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-muted-foreground text-base leading-relaxed', className)}>{children}</p>
  );
}

/** Mono inline token, e.g. kortix.toml */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono', className)}>{children}</span>;
}

/* ── Panel: the home card — rounded-sm, thin border, bg-card ───────────── */

export function Panel({
  children,
  className,
  inverted,
}: {
  children: ReactNode;
  className?: string;
  inverted?: boolean;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-sm border',
        inverted ? 'border-border bg-foreground text-background' : 'border-border bg-card',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Mono label chip — the home step label (`bg-primary text-background`). */
export function LabelChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'bg-primary text-background w-fit rounded px-2 py-1 font-mono text-xs tracking-wider',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Outline mono pill (mirrors hero install-chip border treatment). */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'border-border bg-card text-muted-foreground inline-flex w-fit items-center gap-2 rounded-sm border px-3 py-1.5 font-mono text-xs',
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Bulleted list with the KortixAsterisk glyph (home idiom) ──────────── */

export function Bullets({
  items,
  index = 0,
  className,
}: {
  items: ReactNode[];
  index?: number;
  className?: string;
}) {
  return (
    <ul className={cn('text-muted-foreground space-y-2 text-[15px] leading-relaxed', className)}>
      {items.map((it, i) => (
        <li key={i} className="flex gap-2">
          <KortixAsterisk index={index + i} />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Product screenshot in a framed card (home uses real screenshots) ──── */

export function Shot({
  src,
  alt,
  url = 'kortix.com',
  chrome = true,
  className,
}: {
  src: string;
  alt: string;
  url?: string;
  chrome?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-sm border', className)}>
      {chrome ? (
        <div className="border-border flex items-center gap-1.5 border-b px-3 py-2">
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted text-muted-foreground ml-2 truncate rounded-sm px-2.5 py-0.5 font-mono text-xs">
            {url}
          </span>
        </div>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="block w-full select-none" draggable={false} />
    </div>
  );
}

/* ── Terminal block (mirrors hero/CLI mono surfaces) ───────────────────── */

export function Terminal({
  title = 'zsh',
  lines,
  className,
}: {
  title?: string;
  lines: { kind: 'cmd' | 'out' | 'comment'; text: string }[];
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-sm border', className)}>
      <div className="border-border flex items-center gap-1.5 border-b px-3 py-2">
        <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        <span className="text-muted-foreground ml-2 font-mono text-xs">{title}</span>
      </div>
      <div className="flex flex-col gap-1.5 p-5 font-mono text-sm leading-relaxed">
        {lines.map((l, i) => {
          if (l.kind === 'comment')
            return (
              <div key={i} className="text-muted-foreground/60">
                {l.text}
              </div>
            );
          if (l.kind === 'out')
            return (
              <div key={i} className="text-muted-foreground">
                {l.text}
              </div>
            );
          return (
            <div key={i} className="text-foreground">
              <span className="text-muted-foreground">$ </span>
              {l.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Sub-card used inside grids (home sub-panel) ───────────────────────── */

export function MiniCard({
  label,
  title,
  body,
  className,
}: {
  label?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card flex flex-col gap-2 rounded-sm border p-6', className)}>
      {label ? (
        <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {label}
        </span>
      ) : null}
      <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
      {body ? <p className="text-muted-foreground text-[15px] leading-relaxed">{body}</p> : null}
    </div>
  );
}
