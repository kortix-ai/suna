'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import {
  CheckLine,
  Display,
  Eyebrow,
  InvertedPanel,
  Lead,
  LedeBullet,
  MAX_W,
  Pill,
  Section,
  SoftCard,
} from '@/features/marketing/v2/primitives';
import { RealVisual, hasVisual, isFullBleedVisual } from '@/features/marketing/v2/real-visual';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { type ReactNode, useCallback } from 'react';

/**
 * One component per section kind in the site spec, plus a dispatcher so a page
 * is just an ordered list of sections. All product imagery goes through
 * `RealVisual`, so no section here can render a fabricated screenshot.
 */

/* ── the section contract ────────────────────────────────────────────────── */

export type SectionKind =
  | 'hero'
  | 'showcase'
  | 'split'
  | 'list'
  | 'grid'
  | 'inverted'
  | 'pricing'
  | 'faq'
  | 'cta';

export type SectionSpec = {
  id: string;
  kind: SectionKind;
  /** A string, or an array when the line breaks matter. */
  heading: string | string[];
  body?: string;
  bullets?: string[];
  /** A `RealVisual` identifier: a screenshot path, a component name, `slabs`, or `none`. */
  visual?: string;
  eyebrow?: string;
  /** Puts the visual on the left. `split` only. */
  reversed?: boolean;
  /** Tints the band so consecutive splits separate. */
  tone?: 'plain' | 'muted';
  /** Overrides the column count a `grid` derives from its bullet count. */
  columns?: 2 | 3 | 4;
};

/* ── bullet parsing ──────────────────────────────────────────────────────── */

/**
 * Spec bullets are written as "Lede. The rest of it." or "Term — the rest of
 * it." Both forms split into a bold lede and a muted remainder; anything short
 * with neither marker stays whole.
 */
export function splitBullet(text: string): { lede: string; rest?: string } {
  const dash = text.indexOf(' — ');
  if (dash > 0 && dash <= 70) return { lede: text.slice(0, dash), rest: text.slice(dash + 3) };
  const sentence = text.match(/^(.{1,70}?[.?!])\s+(\S[\s\S]*)$/);
  if (sentence) return { lede: sentence[1], rest: sentence[2] };
  return { lede: text };
}

/** FAQ bullets are written as "Question? Answer." */
export function splitQa(text: string): { question: string; answer: string } {
  const m = text.match(/^([\s\S]+?\?)\s+([\s\S]*)$/);
  return m ? { question: m[1], answer: m[2] } : { question: text, answer: '' };
}

/** Strips the trailing period a lede carries so it can be used as a title. */
const asTitle = (lede: string) => lede.replace(/[.:]$/, '');

/* ── CTAs ────────────────────────────────────────────────────────────────── */

export function CtaPair({ tone = 'default' }: { tone?: 'default' | 'inverse' }) {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const start = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <div className="flex flex-wrap gap-2">
      <Pill variant={tone === 'inverse' ? 'light' : 'dark'} onClick={start}>
        Get started
      </Pill>
      <Pill variant={tone === 'inverse' ? 'ghostLight' : 'soft'} onClick={() => openDemo()}>
        Request demo
      </Pill>
    </div>
  );
}

/* ── hero ────────────────────────────────────────────────────────────────── */

export function HeroSection({
  id,
  heading,
  body,
  bullets,
  visual,
  eyebrow,
  children,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  visual?: string;
  eyebrow?: string;
  children?: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 pt-32 sm:pt-40">
      <div className={MAX_W}>
        <div className="grid items-end gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
            <Display lines={heading} as="h1" className="sm:text-[3.5rem]" />
          </div>
          <div className="lg:pb-2">
            {body && <Lead>{body}</Lead>}
            {bullets && bullets.length > 0 && (
              <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
                {bullets.map((b) => (
                  <CheckLine key={b}>{b}</CheckLine>
                ))}
              </div>
            )}
            <div className="mt-8">
              <CtaPair />
            </div>
          </div>
        </div>
      </div>

      {hasVisual(visual) &&
        (isFullBleedVisual(visual) ? (
          <div className="mt-16">
            <RealVisual name={visual} />
          </div>
        ) : (
          <div className={cn(MAX_W, 'mt-16')}>
            <RealVisual name={visual} size="lg" priority />
          </div>
        ))}

      {children}
    </section>
  );
}

/* ── showcase ────────────────────────────────────────────────────────────── */

/** Centred copy over a full-width visual. */
export function ShowcaseSection({
  id,
  heading,
  body,
  bullets,
  visual,
  eyebrow,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  visual?: string;
  eyebrow?: string;
}) {
  const fullBleed = isFullBleedVisual(visual);
  // A full-bleed component already tells the story its bullets would repeat.
  const showBullets = !fullBleed && bullets && bullets.length > 0;

  return (
    <section id={id} className="scroll-mt-24 py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="mx-auto max-w-2xl text-center">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <Display lines={heading} />
          {body && <Lead className="mt-6">{body}</Lead>}
        </div>
      </div>

      {hasVisual(visual) && (
        <div className={cn(!fullBleed && MAX_W, 'mt-14')}>
          <RealVisual name={visual} size="lg" />
        </div>
      )}

      {showBullets && (
        <div className={cn(MAX_W, 'mt-14')}>
          <div className="grid gap-x-12 sm:grid-cols-2">
            {bullets.map((b) => {
              const { lede, rest } = splitBullet(b);
              return <LedeBullet key={b} lede={lede} rest={rest} />;
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/* ── split ───────────────────────────────────────────────────────────────── */

export function SplitSection({
  id,
  heading,
  body,
  bullets,
  visual,
  eyebrow,
  reversed,
  tone = 'plain',
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  visual?: string;
  eyebrow?: string;
  reversed?: boolean;
  tone?: 'plain' | 'muted';
}) {
  const withVisual = hasVisual(visual) && !isFullBleedVisual(visual);

  return (
    <Section id={id} tone={tone}>
      <div className={cn('grid items-center gap-12', withVisual && 'lg:grid-cols-2 lg:gap-16')}>
        <div className={cn(reversed && 'lg:order-2')}>
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <Display lines={heading} />
          {body && <Lead className="mt-6">{body}</Lead>}
          {bullets && bullets.length > 0 && (
            <div className="mt-8">
              {bullets.map((b) => {
                const { lede, rest } = splitBullet(b);
                return rest ? (
                  <LedeBullet key={b} lede={lede} rest={rest} />
                ) : (
                  <div key={b} className="border-border border-t py-5">
                    <CheckLine>{lede}</CheckLine>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {withVisual && (
          <div className={cn(reversed && 'lg:order-1')}>
            <RealVisual name={visual} />
          </div>
        )}
      </div>
    </Section>
  );
}

/* ── list ────────────────────────────────────────────────────────────────── */

/** Heading on the left, a numbered rail of steps or spec rows on the right. */
export function ListSection({
  id,
  heading,
  body,
  bullets = [],
  eyebrow,
  numbered = false,
  tone = 'plain',
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  eyebrow?: string;
  numbered?: boolean;
  tone?: 'plain' | 'muted';
}) {
  return (
    <Section id={id} tone={tone}>
      <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div>
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <Display lines={heading} />
          {body && <Lead className="mt-6">{body}</Lead>}
        </div>
        <ol>
          {bullets.map((b, i) => {
            const { lede, rest } = splitBullet(b);
            return (
              <li key={b} className="border-border border-t py-6">
                <p className="text-foreground flex items-baseline gap-2.5 text-[1.0625rem] font-medium">
                  {numbered && (
                    <span className="text-muted-foreground/60 font-mono text-xs tabular-nums">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  )}
                  {asTitle(lede)}
                </p>
                {rest && (
                  <p
                    className={cn(
                      'text-muted-foreground mt-2 text-[0.9375rem] leading-[1.6]',
                      numbered && 'pl-[1.9rem]',
                    )}
                  >
                    {rest}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}

/* ── grid ────────────────────────────────────────────────────────────────── */

export function GridSection({
  id,
  heading,
  body,
  bullets = [],
  eyebrow,
  columns,
  visual,
  tone = 'plain',
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  eyebrow?: string;
  columns?: 2 | 3 | 4;
  visual?: string;
  tone?: 'plain' | 'muted';
}) {
  const cols = columns ?? (bullets.length % 3 === 0 ? 3 : bullets.length === 4 ? 4 : 2);

  return (
    <Section id={id} tone={tone}>
      <div className="mx-auto max-w-2xl text-center">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Display lines={heading} />
        {body && <Lead className="mt-6">{body}</Lead>}
      </div>

      <div
        className={cn(
          'mt-14 grid gap-4',
          cols === 2 && 'sm:grid-cols-2',
          cols === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
          cols === 4 && 'sm:grid-cols-2 lg:grid-cols-4',
        )}
      >
        {bullets.map((b) => {
          const { lede, rest } = splitBullet(b);
          return (
            <SoftCard key={b}>
              <p className="text-foreground text-[1.125rem] font-medium">{asTitle(lede)}</p>
              {rest && (
                <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">{rest}</p>
              )}
            </SoftCard>
          );
        })}
      </div>

      {hasVisual(visual) && !isFullBleedVisual(visual) && (
        <div className="mt-14">
          <RealVisual name={visual} size="lg" />
        </div>
      )}
    </Section>
  );
}

/* ── inverted ────────────────────────────────────────────────────────────── */

/** The trust panel: foreground surface, background type, accent bloom. */
export function InvertedSection({
  id,
  heading,
  body,
  bullets = [],
  eyebrow,
  cta,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  eyebrow?: string;
  cta?: { label: string; href: string };
}) {
  return (
    <InvertedPanel id={id}>
      <div className="px-8 pt-14 pb-14 sm:px-14 sm:pt-16">
        <div className="grid gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div>
            {eyebrow && <Eyebrow tone="inverse">{eyebrow}</Eyebrow>}
            <Display lines={heading} tone="inverse" />
          </div>
          <div className="lg:pt-2">
            {body && <Lead tone="inverse">{body}</Lead>}
            {cta && (
              <Pill as="a" href={cta.href} variant="light" className="mt-8">
                {cta.label}
              </Pill>
            )}
          </div>
        </div>

        {bullets.length > 0 && (
          <div className="border-background/15 mt-14 grid gap-x-12 gap-y-2 border-t pt-6 md:grid-cols-2">
            {bullets.map((b) => {
              const { lede, rest } = splitBullet(b);
              return (
                <div key={b} className="border-background/10 border-b py-6 last:border-b-0">
                  <CheckLine tone="inverse">
                    <span className="font-medium">{asTitle(lede)}</span>
                  </CheckLine>
                  {rest && (
                    <p className="text-background/60 mt-2.5 pl-[1.75rem] text-[0.9375rem] leading-[1.55]">
                      {rest}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </InvertedPanel>
  );
}

/* ── pricing ─────────────────────────────────────────────────────────────── */

/** Bullets are "Plan — price. Feature. Feature." — the middle one is featured. */
export function PricingSection({
  id,
  heading,
  body,
  bullets = [],
  eyebrow,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  eyebrow?: string;
}) {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const start = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  const plans = bullets.map((b, i) => {
    const { lede, rest = '' } = splitBullet(b);
    const [price, ...features] = rest.split(/(?<=\.)\s+/);
    return {
      name: asTitle(lede),
      price: price?.replace(/\.$/, '') ?? '',
      features: features.filter(Boolean),
      featured: i === 1,
      enterprise: /enterprise/i.test(lede),
    };
  });

  return (
    <Section id={id}>
      <div className="mx-auto max-w-2xl text-center">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Display lines={heading} />
        {body && <Lead className="mt-6">{body}</Lead>}
      </div>

      <div className="mt-14 grid gap-4 lg:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={cn(
              'flex flex-col rounded-[1.35rem] p-8',
              plan.featured ? 'text-white' : 'border-border border',
            )}
            style={
              plan.featured
                ? {
                    background:
                      'linear-gradient(160deg, color-mix(in oklab, var(--kortix-blue) 86%, black) 0%, var(--kortix-blue) 100%)',
                  }
                : undefined
            }
          >
            <p
              className={cn(
                'text-[1.375rem] font-medium',
                plan.featured ? 'text-white' : 'text-foreground',
              )}
            >
              {plan.name}
            </p>
            <p
              className={cn(
                'mt-6 text-[2rem] leading-none font-medium tracking-tight',
                plan.featured ? 'text-white' : 'text-foreground',
              )}
            >
              {plan.price}
            </p>

            <button
              type="button"
              onClick={plan.enterprise ? () => openDemo() : start}
              className={cn(
                'mt-7 flex h-11 w-full cursor-pointer items-center justify-center rounded-full text-[0.9375rem] font-medium transition-colors',
                plan.featured
                  ? 'bg-background text-foreground hover:bg-background/90'
                  : 'bg-foreground/[0.06] text-foreground hover:bg-foreground/10',
              )}
            >
              {plan.enterprise ? 'Talk to us' : 'Get started'}
            </button>

            <ul className="mt-8 space-y-3.5">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      'mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full',
                      plan.featured ? 'bg-white/20 text-white' : 'bg-kortix-blue text-white',
                    )}
                  >
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                  <span
                    className={cn(
                      'text-[0.9375rem] leading-[1.45]',
                      plan.featured ? 'text-white/90' : 'text-foreground',
                    )}
                  >
                    {f}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── faq ─────────────────────────────────────────────────────────────────── */

export function FaqSection({
  id,
  heading,
  body,
  bullets = [],
  eyebrow,
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  bullets?: string[];
  eyebrow?: string;
}) {
  return (
    <Section id={id}>
      <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <div>
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <Display lines={heading} />
          {body && <Lead className="mt-6">{body}</Lead>}
        </div>
        <div>
          {bullets.map((b) => {
            const { question, answer } = splitQa(b);
            return (
              <div key={b} className="border-border border-t py-6">
                <p className="text-foreground text-[1.0625rem] font-medium">{question}</p>
                {answer && (
                  <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.6]">
                    {answer}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

/* ── page close ──────────────────────────────────────────────────────────── */

export function CtaSection({
  id,
  heading,
  body,
  visual = 'KortixGrid',
}: {
  id?: string;
  heading: string | string[];
  body?: string;
  visual?: string;
}) {
  return (
    <section
      id={id}
      className="relative isolate overflow-hidden"
      style={{
        background:
          'linear-gradient(150deg, color-mix(in oklab, var(--kortix-blue) 4%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 13%, var(--background)) 100%)',
      }}
    >
      {hasVisual(visual) && (
        <div className="absolute inset-y-0 right-[-6%] hidden w-[46%] lg:block">
          <RealVisual name={visual} className="h-full" />
        </div>
      )}

      <div className={cn(MAX_W, 'relative py-24 sm:py-32')}>
        <div className="max-w-xl">
          <Display lines={heading} />
          {body && <Lead className="mt-7">{body}</Lead>}
          <div className="mt-9">
            <CtaPair />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── the dispatcher ──────────────────────────────────────────────────────── */

export function PageSection({ section }: { section: SectionSpec }) {
  const { kind, ...rest } = section;
  switch (kind) {
    case 'hero':
      return <HeroSection {...rest} />;
    case 'showcase':
      return <ShowcaseSection {...rest} />;
    case 'split':
      return <SplitSection {...rest} />;
    case 'list':
      return <ListSection {...rest} numbered />;
    case 'grid':
      return <GridSection {...rest} />;
    case 'inverted':
      return <InvertedSection {...rest} />;
    case 'pricing':
      return <PricingSection {...rest} />;
    case 'faq':
      return <FaqSection {...rest} />;
    case 'cta':
      return <CtaSection {...rest} />;
  }
}

/** A whole page: an ordered list of sections. */
export function PageSections({ sections }: { sections: SectionSpec[] }) {
  return (
    <main className="bg-background">
      {sections.map((section) => (
        <PageSection key={section.id} section={section} />
      ))}
    </main>
  );
}
