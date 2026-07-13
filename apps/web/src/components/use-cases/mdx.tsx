import { Children, isValidElement, cloneElement, type ReactNode } from 'react';

import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { cn } from '@/lib/utils';

/**
 * Case-study MDX kit. Presentational blocks authors compose inside a use-case
 * `.mdx` to tell an enterprise-grade story: problem → build → proof. Built to
 * the marketing design language — `rounded-sm`, the `bg-border … gap-px`
 * divider grid, `Badge`-style mono eyebrows — so a case study reads as the same
 * surface as the landing page. Each root resets the inherited <BlogProse>
 * paragraph spacing it owns.
 */

// Neutralize BlogProse's `[&_p]:my-5` inside our own boxes and control spacing.
const proseReset = '[&_p]:!my-0 [&_p+p]:!mt-3 [&_ul]:!my-3 [&_ol]:!my-3 [&_li]:!pl-1';

/** "At a glance" fact sheet — the signature divider grid. Compose with
 * <Fact label="…">value</Fact>. */
export function KeyFacts({ children }: { children: ReactNode }) {
  return (
    <div className="bg-border border-border my-8 grid gap-px overflow-hidden rounded-sm border grid-cols-2 sm:grid-cols-4">
      {children}
    </div>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-card flex flex-col gap-2 p-5 md:p-6">
      <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
        {label}
      </span>
      <span className="text-foreground text-sm leading-snug font-medium">{children}</span>
    </div>
  );
}

/** Emphasis box for a key point or aside. */
export function Callout({
  title,
  children,
  tone = 'neutral',
}: {
  title?: string;
  children: ReactNode;
  tone?: 'neutral' | 'accent';
}) {
  return (
    <div
      className={cn(
        'border-border my-8 flex gap-4 rounded-sm border p-6 md:p-7',
        tone === 'accent' ? 'bg-kortix-base/[0.06]' : 'bg-card',
      )}
    >
      <KortixAsterisk index={0} parentClass="mt-0.5 size-5 shrink-0" />
      <div className={cn('min-w-0', proseReset)}>
        {title && (
          <p className="text-foreground !mb-2 text-base font-medium tracking-tight">{title}</p>
        )}
        <div className="text-muted-foreground text-sm leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

/** Numbered step-by-step, connected as one divider grid. Wrap <Step title="…">
 * items; numbering is automatic. */
export function Steps({ children }: { children: ReactNode }) {
  const steps = Children.toArray(children).filter(isValidElement);
  return (
    <div className="bg-border border-border my-8 grid gap-px overflow-hidden rounded-sm border">
      {steps.map((child, i) =>
        cloneElement(child as any, { number: i + 1, key: (child as any).key ?? i }),
      )}
    </div>
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
    <div className="bg-card p-6 md:p-8">
      <div className="flex items-baseline gap-4">
        <span className="text-foreground/25 font-mono text-lg font-medium tabular-nums">
          {String(number ?? 0).padStart(2, '0')}
        </span>
        <h3 className="text-foreground !m-0 text-lg font-medium tracking-tight sm:text-xl">
          {title}
        </h3>
      </div>
      <div
        className={cn(
          'text-muted-foreground mt-4 pl-9 text-[0.95rem] leading-relaxed',
          proseReset,
        )}
      >
        {children}
      </div>
    </div>
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
  return (
    <figure className="my-8">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt ?? caption ?? ''}
          loading="lazy"
          className="border-border !my-0 w-full rounded-sm border"
        />
      ) : (
        <div
          className="border-border bg-muted/40 text-muted-foreground/70 flex items-center justify-center rounded-sm border border-dashed"
          style={{ aspectRatio: aspect }}
        >
          <span className="flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
            <KortixAsterisk index={0} parentClass="size-3.5" variant="solid" />
            {caption ? `Screenshot — ${caption}` : 'Screenshot'}
          </span>
        </div>
      )}
      {caption && (
        <figcaption className="text-muted-foreground mt-3 font-mono text-xs tracking-wide">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

/** Outcome tiles — divider grid. Compose with <Stat value="…" label="…" />. */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="bg-border border-border my-8 grid gap-px overflow-hidden rounded-sm border grid-cols-1 sm:grid-cols-3">
      {children}
    </div>
  );
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-card flex flex-col p-6 md:p-8">
      <span className="text-foreground text-3xl leading-none font-medium tracking-tight sm:text-4xl">
        {value}
      </span>
      <span className="text-muted-foreground mt-3 text-sm leading-relaxed">{label}</span>
    </div>
  );
}

/** Large pull quote to break up the read and land the key line. */
export function PullQuote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="my-12 !border-l-0 !pl-0 text-center">
      <KortixAsterisk index={0} parentClass="mx-auto mb-5 size-6" />
      <p className="text-foreground mx-auto max-w-2xl text-xl leading-snug font-medium tracking-tight text-balance !not-italic sm:text-2xl">
        {children}
      </p>
    </blockquote>
  );
}
