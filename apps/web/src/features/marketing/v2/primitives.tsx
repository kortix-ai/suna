'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The marketing dialect: `max-w-6xl px-6 py-16 sm:py-24`, `rounded-sm`, hairline
 * borders, one accent. Everything here is token-driven so light and dark both work.
 */

export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn('scroll-mt-24 px-6 py-16 sm:py-24', className)}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Badge variant="kortix" className="rounded">
      {children}
    </Badge>
  );
}

/** Display heading. Pass an array so the line break is deliberate. */
export function Heading({
  lines,
  className,
  as: As = 'h2',
  tone = 'default',
}: {
  lines: string[];
  className?: string;
  as?: 'h1' | 'h2' | 'h3';
  tone?: 'default' | 'inverse';
}) {
  return (
    <As
      className={cn(
        'text-3xl leading-tight font-medium tracking-tight sm:text-4xl',
        tone === 'inverse' ? 'text-background' : 'text-foreground',
        className,
      )}
    >
      {lines.map((line) => (
        <span key={line} className="block text-balance">
          {line}
        </span>
      ))}
    </As>
  );
}

export function Lead({
  children,
  className,
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'inverse';
}) {
  return (
    <p
      className={cn(
        'text-base leading-relaxed',
        tone === 'inverse' ? 'text-background/70' : 'text-muted-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A bold lede followed by supporting text, split by a hairline. */
export function LedeBullet({ lede, rest }: { lede: string; rest: string }) {
  return (
    <div className="border-border border-t py-5">
      <p className="text-[0.9375rem] leading-relaxed">
        <span className="text-foreground font-medium">{lede}</span>{' '}
        <span className="text-muted-foreground">{rest}</span>
      </p>
    </div>
  );
}

/** Tick + label. Contrast holds on both the page and the inverted panel. */
export function CheckLine({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'inverse';
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
          tone === 'inverse' ? 'text-foreground bg-background' : 'bg-kortix-blue text-white',
        )}
      >
        <Check className="size-2.5" strokeWidth={3} />
      </span>
      <span
        className={cn(
          'text-[0.9375rem] leading-snug',
          tone === 'inverse' ? 'text-background' : 'text-foreground',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** Neutral surface used behind product stills — the marketing card, not a tint. */
export function Frame({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('border-border bg-card relative overflow-hidden rounded-sm border', className)}>
      {children}
    </div>
  );
}
