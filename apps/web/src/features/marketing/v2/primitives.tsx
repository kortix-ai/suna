'use client';

import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Layout and type primitives for /v2.
 *
 * Everything here is token-driven and resolves in both themes: neutral surfaces
 * come from bg-background / bg-card / bg-muted, and the single accent is always
 * reached through var(--kortix-blue) — never a literal hex. Inverted surfaces
 * use bg-foreground + text-background so they flip with the theme instead of
 * pinning themselves to black.
 */

export const MAX_W = 'mx-auto w-full max-w-[68rem] px-6';

export type Tone = 'default' | 'inverse';

/* ── surfaces ────────────────────────────────────────────────────────────── */

/** A page section on the plain page background. */
export function Section({
  id,
  className,
  tone = 'plain',
  children,
}: {
  id?: string;
  className?: string;
  /** `muted` gives the band a hairline-bounded tint so adjacent splits separate. */
  tone?: 'plain' | 'muted';
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        'scroll-mt-24 py-20 sm:py-28',
        tone === 'muted' && 'bg-muted/40 border-border border-y',
        className,
      )}
    >
      <div className={MAX_W}>{children}</div>
    </section>
  );
}

/** The soft accent-tinted rounded panel used for feature blocks. */
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

/** The inverted trust panel: foreground surface, background type. */
export function InvertedPanel({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 px-6 py-6">
      <div
        className={cn(
          'bg-foreground relative mx-auto w-full max-w-[68rem] overflow-hidden rounded-[1.75rem]',
          className,
        )}
      >
        <div
          aria-hidden
          data-a11y-decorative
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(65% 55% at 82% 8%, color-mix(in oklab, var(--kortix-blue) 30%, transparent) 0%, transparent 68%)',
          }}
        />
        <div className="relative">{children}</div>
      </div>
    </section>
  );
}

/** The soft card used for grid items and link tiles. */
export function SoftCard({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('flex flex-col rounded-[1.1rem] p-6', className)}
      style={{
        background:
          'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 3%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 11%, var(--background)) 100%)',
        border: '1px solid color-mix(in oklab, var(--kortix-blue) 11%, transparent)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ── type ────────────────────────────────────────────────────────────────── */

export function Eyebrow({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return (
    <p
      className={cn(
        'mb-4 text-[13px] tracking-wider uppercase',
        tone === 'inverse' ? 'text-background/55' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  );
}

/** Display heading. Pass a string, or an array to control the line breaks. */
export function Display({
  lines,
  className,
  tone = 'default',
  as: As = 'h2',
}: {
  lines: string | string[];
  className?: string;
  tone?: Tone;
  as?: 'h1' | 'h2' | 'h3';
}) {
  const rows = Array.isArray(lines) ? lines : [lines];
  return (
    <As
      className={cn(
        'text-[2.25rem] leading-[1.08] font-medium tracking-[-0.02em] text-balance sm:text-[3rem]',
        tone === 'inverse' ? 'text-background' : 'text-foreground',
        className,
      )}
    >
      {rows.map((line) => (
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
  tone?: Tone;
}) {
  return (
    <p
      className={cn(
        'text-[1.0625rem] leading-[1.6]',
        tone === 'inverse' ? 'text-background/65' : 'text-muted-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Bold lede + muted rest, separated by a hairline. */
export function LedeBullet({
  lede,
  rest,
  tone = 'default',
}: {
  lede: string;
  rest?: string;
  tone?: Tone;
}) {
  return (
    <div
      className={cn('border-t py-6', tone === 'inverse' ? 'border-background/15' : 'border-border')}
    >
      <p className="text-[1.0625rem] leading-[1.6]">
        <span
          className={cn('font-medium', tone === 'inverse' ? 'text-background' : 'text-foreground')}
        >
          {lede}
        </span>
        {rest && (
          <>
            {' '}
            <span className={tone === 'inverse' ? 'text-background/60' : 'text-muted-foreground'}>
              {rest}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/** Accent circular tick + label. */
export function CheckLine({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          'mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full',
          tone === 'inverse' ? 'bg-background text-foreground' : 'bg-kortix-blue text-white',
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span
        className={cn(
          'text-[0.9375rem] leading-[1.45]',
          tone === 'inverse' ? 'text-background' : 'text-foreground',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/* ── controls ────────────────────────────────────────────────────────────── */

export type PillVariant = 'dark' | 'light' | 'ghost' | 'ghostLight' | 'soft';

const PILL: Record<PillVariant, string> = {
  dark: 'bg-foreground text-background hover:bg-foreground/90',
  light: 'bg-background text-foreground hover:bg-background/90',
  ghost: 'text-foreground hover:bg-foreground/5',
  ghostLight: 'text-background hover:bg-background/15',
  soft: 'bg-foreground/[0.07] text-foreground hover:bg-foreground/10',
};

/** Pill button or link. `light` / `ghostLight` are for inverted surfaces. */
export function Pill({
  children,
  variant = 'dark',
  className,
  onClick,
  href,
  as = 'button',
}: {
  children: ReactNode;
  variant?: PillVariant;
  className?: string;
  onClick?: () => void;
  href?: string;
  as?: 'button' | 'a';
}) {
  const cls = cn(
    'inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full px-6 text-[0.9375rem] font-medium transition-colors',
    PILL[variant],
    className,
  );

  if (as === 'a' && href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}
