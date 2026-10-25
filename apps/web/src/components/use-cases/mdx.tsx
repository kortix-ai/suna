'use client';

import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';

/**
 * Case-study MDX kit. Presentational blocks authors compose inside a use-case
 * `.mdx` to tell the story: problem → build → proof. Built to the Buio
 * marketing language: no boxes, no radius, no fills. Structure comes from
 * hairlines in `border-border`, and every block uses the two text colours
 * only. Each root resets the inherited <BlogProse> spacing it owns.
 */

// Neutralize BlogProse's `[&_p]:my-5` inside our own blocks and control spacing.
const proseReset = '[&_p]:!my-0 [&_p+p]:!mt-3 [&_ul]:!my-3 [&_ol]:!my-3 [&_li]:!pl-1';

/** "At a glance" fact sheet: a row of label / value pairs between two
 * hairlines. Compose with <Fact label="…">value</Fact>. */
export function KeyFacts({ children }: { children: ReactNode }) {
  return (
    <dl className="border-border my-10 grid grid-cols-2 border-y sm:grid-cols-4">{children}</dl>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-6 pr-6">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className={cn('text-foreground mt-1 text-base font-medium text-pretty', proseReset)}>
        {children}
      </dd>
    </div>
  );
}

/** Emphasis for a key point or aside: a 1px ink rule on the left. `tone` is
 * kept for existing content and no longer changes the look. */
export function Callout({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
  tone?: 'neutral' | 'accent';
}) {
  return (
    <aside className={cn('border-foreground my-10 border-l pl-6', proseReset)}>
      {title ? <p className="text-foreground !mb-2 text-base font-medium">{title}</p> : null}
      <div className="text-muted-foreground">{children}</div>
    </aside>
  );
}

/** Numbered step-by-step as one hairline list. Wrap <Step title="…"> items;
 * numbering is automatic. */
export function Steps({ children }: { children: ReactNode }) {
  const steps = Children.toArray(children).filter(isValidElement);
  return (
    <ol className="border-border my-10 !list-none border-b !pl-0">
      {steps.map((child, i) =>
        cloneElement(child as any, { number: i + 1, key: (child as any).key ?? i }),
      )}
    </ol>
  );
}

export function Step({
  title,
  children,
  number,
}: {
  title: string;
  children: ReactNode;
  number?: number;
}) {
  return (
    <li className="border-border flex gap-6 border-t py-6 !pl-0">
      <span className="text-muted-foreground w-6 shrink-0 text-base tabular-nums">
        {number ?? 0}
      </span>
      <div className="min-w-0">
        <h3 className="text-foreground !m-0 !text-base font-medium">{title}</h3>
        <div className={cn('text-muted-foreground mt-2', proseReset)}>{children}</div>
      </div>
    </li>
  );
}

/** A framed screenshot / photo with a caption. Falls back to a labelled
 * placeholder frame when `src` is absent, so the layout reads as intentional
 * before real assets are captured. Drop images under /public and pass the path. */
export function Figure({
  src,
  alt,
  caption,
  aspect = '16/9',
}: {
  src?: string;
  alt?: string;
  caption?: string;
  aspect?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <figure className="my-10">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt ?? caption ?? ''}
          loading="lazy"
          className="border-border !my-0 w-full !rounded-none border"
        />
      ) : (
        <div
          className="bg-muted text-muted-foreground flex items-center justify-center text-sm"
          style={{ aspectRatio: aspect }}
        >
          {caption
            ? tI18nComplete('text9b1a9ce91460', { value0: caption })
            : tI18nComplete.raw('text907c7115cf85')}
        </div>
      )}
      {caption ? (
        <figcaption className="text-muted-foreground mt-3 text-sm">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/** Outcome figures in a hairline row. Compose with <Stat value="…" label="…" />. */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="border-border my-10 grid grid-cols-1 border-t sm:grid-cols-3">{children}</dl>
  );
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col py-6 pr-6">
      <dt className="text-muted-foreground mt-2 text-sm text-pretty">{label}</dt>
      <dd className="text-foreground order-first text-2xl font-medium tracking-tight">
        {value}
      </dd>
    </div>
  );
}

/** Large pull quote to break up the read and land the key line. */
export function PullQuote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="my-12 !border-l-0 !pl-0">
      <p className="text-foreground text-xl font-medium tracking-tight text-balance !not-italic md:text-2xl">
        {children}
      </p>
    </blockquote>
  );
}
