'use client';

import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

/** Marketing section shell — the page's one horizontal rhythm. */
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
    <section id={id} className={cn('scroll-mt-24 py-20 sm:py-28', className)}>
      <div className="mx-auto max-w-6xl px-6">{children}</div>
    </section>
  );
}

/** Two-line display heading. Pass an array so the line break is deliberate. */
export function Heading({
  lines,
  className,
  as: As = 'h2',
}: {
  lines: string[];
  className?: string;
  as?: 'h1' | 'h2' | 'h3';
}) {
  return (
    <As
      className={cn(
        'text-foreground text-[2rem] leading-[1.1] font-medium tracking-[-0.02em] sm:text-[2.75rem]',
        className,
      )}
    >
      {lines.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </As>
  );
}

/** A bold lede followed by muted supporting text, split by a hairline. */
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

/** Blue tick + label, used in the self-host and security blocks. */
export function CheckLine({ children, tone = 'light' }: { children: ReactNode; tone?: 'light' | 'dark' }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
          tone === 'light' ? 'bg-kortix-blue/15 text-kortix-blue' : 'bg-white text-neutral-900',
        )}
      >
        <Check className="size-2.5" strokeWidth={3} />
      </span>
      <span
        className={cn(
          'text-[0.9375rem] leading-snug',
          tone === 'light' ? 'text-foreground' : 'text-white',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** Soft blue-tinted panel used behind the illustrated blocks. */
export function TintPanel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'border-border relative overflow-hidden rounded-2xl border',
        'bg-[linear-gradient(135deg,var(--tint-a)_0%,var(--tint-b)_55%,var(--tint-a)_100%)]',
        className,
      )}
      style={
        {
          '--tint-a': 'color-mix(in oklab, var(--kortix-blue) 5%, var(--background))',
          '--tint-b': 'color-mix(in oklab, var(--kortix-blue) 12%, var(--background))',
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
