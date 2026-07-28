'use client';

import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Layout primitives for the landing page. The page is a close structural
 * recreation of tembo.io rendered in Kortix's brand: same section rhythm, same
 * panel geometry, Kortix blue as the single accent.
 */

export const MAX_W = 'mx-auto w-full max-w-[68rem] px-6';

/** Plain section — white page background. */
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
      <div className={MAX_W}>{children}</div>
    </section>
  );
}

/** The big soft-tinted rounded panel Tembo uses for its feature blocks. */
export function Panel({
  id,
  className,
  style,
  children,
}: {
  id?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 px-6 py-6">
      <div
        className={cn('mx-auto w-full max-w-[68rem] overflow-hidden rounded-[1.75rem]', className)}
        style={{
          background:
            'linear-gradient(155deg, var(--panel-a) 0%, var(--panel-b) 55%, var(--panel-a) 100%)',
          ...({
            '--panel-a': 'color-mix(in oklab, var(--kortix-blue) 6%, var(--background))',
            '--panel-b': 'color-mix(in oklab, var(--kortix-blue) 13%, var(--background))',
          } as CSSProperties),
          ...style,
        }}
      >
        {children}
      </div>
    </section>
  );
}

/** Centred display heading, two deliberate lines. */
export function Display({
  lines,
  className,
  tone = 'default',
  as: As = 'h2',
}: {
  lines: string[];
  className?: string;
  tone?: 'default' | 'inverse';
  as?: 'h1' | 'h2';
}) {
  return (
    <As
      className={cn(
        'text-[2.25rem] leading-[1.08] font-medium tracking-[-0.02em] sm:text-[3rem]',
        tone === 'inverse' ? 'text-white' : 'text-foreground',
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
        'text-[1.0625rem] leading-[1.6]',
        tone === 'inverse' ? 'text-white/60' : 'text-muted-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Bold lede + muted rest, separated by a hairline — Tembo's bullet pattern. */
export function LedeBullet({ lede, rest }: { lede: string; rest: string }) {
  return (
    <div className="border-border border-t py-6">
      <p className="text-[1.0625rem] leading-[1.6]">
        <span className="text-foreground font-medium">{lede}</span>{' '}
        <span className="text-muted-foreground">{rest}</span>
      </p>
    </div>
  );
}

/** Blue circular tick + label. */
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
          'mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full',
          tone === 'inverse' ? 'bg-white text-neutral-900' : 'bg-kortix-blue text-white',
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span
        className={cn(
          'text-[0.9375rem] leading-[1.45]',
          tone === 'inverse' ? 'text-white' : 'text-foreground',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** Pill button, the shape Tembo uses everywhere. */
export function Pill({
  children,
  variant = 'dark',
  className,
  onClick,
  as = 'button',
  href,
}: {
  children: ReactNode;
  variant?: 'dark' | 'light' | 'ghost' | 'ghostLight' | 'soft';
  className?: string;
  onClick?: () => void;
  as?: 'button' | 'a';
  href?: string;
}) {
  const styles = {
    dark: 'bg-foreground text-background hover:bg-foreground/90',
    light: 'bg-white text-neutral-900 hover:bg-white/90',
    ghost: 'text-foreground hover:bg-foreground/5',
    ghostLight: 'text-white hover:bg-white/15',
    soft: 'bg-foreground/[0.07] text-foreground hover:bg-foreground/10',
  }[variant];

  const cls = cn(
    'inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full px-6 text-[0.9375rem] font-medium transition-colors',
    styles,
    className,
  );

  if (as === 'a') {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}
