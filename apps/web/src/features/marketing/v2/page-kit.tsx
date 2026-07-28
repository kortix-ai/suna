'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { SlabMark } from '@/features/marketing/v2/illustrations';
import { CheckLine, Display, Lead, MAX_W, Pill } from '@/features/marketing/v2/primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { useCallback, type ReactNode } from 'react';

/**
 * Shared building blocks for the marketing sub-pages. Each page is a
 * composition of these: hero → showcase → feature grid → split → CTA.
 */

/* ── CTAs ────────────────────────────────────────────────────────────────── */

export function CtaPair({ tone = 'default' }: { tone?: 'default' | 'light' }) {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const start = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <div className="flex flex-wrap gap-2">
      <Pill variant={tone === 'light' ? 'light' : 'dark'} onClick={start}>
        Get started
      </Pill>
      <Pill variant={tone === 'light' ? 'ghostLight' : 'soft'} onClick={() => openDemo()}>
        Request demo
      </Pill>
    </div>
  );
}

/* ── heroes ──────────────────────────────────────────────────────────────── */

/** Headline on one side, supporting copy + CTAs on the other. */
export function SplitHero({
  heading,
  body,
  reversed,
  children,
}: {
  heading: string[];
  body: string;
  reversed?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="pt-32 sm:pt-40">
      <div className={MAX_W}>
        <div className="grid items-end gap-10 lg:grid-cols-2 lg:gap-16">
          <div className={cn(reversed && 'lg:order-2')}>
            <Display lines={heading} as="h1" className="sm:text-[3.5rem]" />
          </div>
          <div className={cn('lg:pb-2', reversed && 'lg:order-1')}>
            <Lead>{body}</Lead>
            <div className="mt-8">
              <CtaPair />
            </div>
          </div>
        </div>
        {children && <div className="mt-16">{children}</div>}
      </div>
    </section>
  );
}

/** Centred hero for pricing, use-cases, company pages. */
export function CenterHero({
  heading,
  body,
  cta = true,
  children,
}: {
  heading: string[];
  body: string;
  cta?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="pt-32 sm:pt-40">
      <div className={MAX_W}>
        <div className="mx-auto max-w-2xl text-center">
          <Display lines={heading} as="h1" className="sm:text-[3.5rem]" />
          <Lead className="mt-6">{body}</Lead>
          {cta && (
            <div className="mt-9 flex justify-center">
              <CtaPair />
            </div>
          )}
        </div>
        {children && <div className="mt-16">{children}</div>}
      </div>
    </section>
  );
}

/* ── showcase ────────────────────────────────────────────────────────────── */

/** A product still floated on a soft accent wash. */
export function Showcase({
  children,
  className,
  height = 'h-[30rem]',
}: {
  children: ReactNode;
  className?: string;
  height?: string;
}) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-[1.5rem] p-6 sm:p-12', height, className)}
      style={{
        background:
          'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 4%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 20%, var(--background)) 100%)',
        border: '1px solid color-mix(in oklab, var(--kortix-blue) 12%, transparent)',
      }}
    >
      {children}
    </div>
  );
}

/** The floating white card used inside a Showcase. */
export function Floating({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'bg-background overflow-hidden rounded-[0.9rem] shadow-[0_18px_50px_-12px_rgba(26,31,46,0.22)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── feature grid ────────────────────────────────────────────────────────── */

export type Feature = { name: string; description: string };

export function FeatureGrid({
  eyebrow,
  heading,
  body,
  items,
  columns = 3,
  illustrated,
}: {
  eyebrow?: string;
  heading: string[];
  body?: string;
  items: Feature[];
  columns?: 2 | 3 | 4;
  illustrated?: boolean;
}) {
  return (
    <section className="py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="mx-auto max-w-2xl text-center">
          {eyebrow && (
            <p className="text-muted-foreground mb-4 text-[13px] tracking-wider uppercase">
              {eyebrow}
            </p>
          )}
          <Display lines={heading} />
          {body && <Lead className="mt-6">{body}</Lead>}
        </div>

        <div
          className={cn(
            'mt-14 grid gap-4',
            columns === 2 && 'sm:grid-cols-2',
            columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
            columns === 4 && 'sm:grid-cols-2 lg:grid-cols-4',
          )}
        >
          {items.map((item, i) => (
            <div
              key={item.name}
              className="flex flex-col rounded-[1.1rem] p-6"
              style={{
                background:
                  'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 3%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 10%, var(--background)) 100%)',
                border: '1px solid color-mix(in oklab, var(--kortix-blue) 11%, transparent)',
              }}
            >
              {illustrated && <SlabMark count={(i % 3) + 1} tone="accent" className="mb-4" />}
              <p className="text-foreground text-[1.125rem] font-medium">{item.name}</p>
              <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── split block ─────────────────────────────────────────────────────────── */

export function SplitBlock({
  heading,
  body,
  checks,
  visual,
  reversed,
  tinted,
}: {
  heading: string[];
  body: string;
  checks?: string[];
  visual?: ReactNode;
  reversed?: boolean;
  tinted?: boolean;
}) {
  return (
    <section className={cn('py-20 sm:py-28', tinted && 'bg-muted/40 border-border border-y')}>
      <div className={MAX_W}>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div className={cn(reversed && 'lg:order-2')}>
            <Display lines={heading} />
            <Lead className="mt-6">{body}</Lead>
            {checks && (
              <div className="mt-8 space-y-4">
                {checks.map((c) => (
                  <CheckLine key={c}>{c}</CheckLine>
                ))}
              </div>
            )}
          </div>
          {visual && (
            <Showcase className={cn(reversed && 'lg:order-1')} height="h-[26rem]">
              <div className="flex h-full items-center justify-center">{visual}</div>
            </Showcase>
          )}
        </div>
      </div>
    </section>
  );
}

/* ── spec table ──────────────────────────────────────────────────────────── */

export function SpecList({
  heading,
  rows,
}: {
  heading: string[];
  rows: { label: string; value: string }[];
}) {
  return (
    <section className="py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          <Display lines={heading} />
          <dl>
            {rows.map((row) => (
              <div
                key={row.label}
                className="border-border grid gap-2 border-t py-5 sm:grid-cols-[13rem_1fr]"
              >
                <dt className="text-foreground text-[0.9375rem] font-medium">{row.label}</dt>
                <dd className="text-muted-foreground text-[0.9375rem] leading-[1.55]">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

/* ── faq ─────────────────────────────────────────────────────────────────── */

export function Faq({ heading, items }: { heading: string[]; items: Feature[] }) {
  return (
    <section className="py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
          <Display lines={heading} />
          <div>
            {items.map((item) => (
              <div key={item.name} className="border-border border-t py-6">
                <p className="text-foreground text-[1.0625rem] font-medium">{item.name}</p>
                <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.6]">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── page close ──────────────────────────────────────────────────────────── */

export function PageCta({ heading, body }: { heading: string[]; body: string }) {
  return (
    <section
      className="relative isolate overflow-hidden"
      style={{
        background:
          'linear-gradient(150deg, color-mix(in oklab, var(--kortix-blue) 4%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 12%, var(--background)) 100%)',
      }}
    >
      <div className={`${MAX_W} py-24 sm:py-28`}>
        <div className="mx-auto max-w-2xl text-center">
          <Display lines={heading} />
          <Lead className="mt-6">{body}</Lead>
          <div className="mt-9 flex justify-center">
            <CtaPair />
          </div>
        </div>
      </div>
    </section>
  );
}
