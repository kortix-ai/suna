'use client';

import { Reveal } from '@/components/home/reveal';
import { Separator } from '@/components/ui/separator';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import { ArrowRightIcon, LockKeyIcon, ProhibitIcon } from '@phosphor-icons/react';
import { broker } from './content';
import { Eyebrow, Section } from './shared';

/**
 * One env-var panel. `before` renders its keys struck through and dimmed, so a
 * reader skimming the two panels side by side sees the difference before they
 * read a word of either.
 */
function EnvPanel({
  label,
  title,
  lines,
  body,
  muted,
}: {
  label: string;
  title: string;
  lines: readonly string[];
  body: string;
  muted?: boolean;
}) {
  return (
    <article
      className={cn(
        'flex h-full flex-col p-6 sm:p-8',
        muted ? 'bg-foreground/[0.02]' : 'bg-card',
      )}
    >
      <Eyebrow>{label}</Eyebrow>
      <h3
        className={cn(
          'mt-4 text-lg leading-tight font-medium tracking-tight',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {title}
      </h3>

      <ul className="mt-5 space-y-1.5">
        {lines.map((line) => (
          <li
            key={line}
            className={cn(
              'flex items-center gap-2 font-mono text-[11px] leading-relaxed',
              muted ? 'text-muted-foreground/60' : 'text-foreground',
            )}
          >
            {muted ? (
              <ProhibitIcon aria-hidden className="text-muted-foreground/50 size-3 shrink-0" />
            ) : (
              <LockKeyIcon aria-hidden className="text-foreground/60 size-3 shrink-0" />
            )}
            <span className={cn('truncate', muted && 'line-through decoration-1')}>{line}</span>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground mt-auto pt-5 text-sm leading-relaxed">{body}</p>
    </article>
  );
}

/**
 * The token-flow diagram — the load-bearing picture on this page.
 *
 * A dashed rule runs between step 01 and step 02. Everything left of it happens
 * inside the sandbox the model drives; everything right of it happens on Kortix.
 * The credential only ever exists on the right. The strip underneath names what
 * never crosses, because that is the claim the whole page rests on.
 */
function FlowDiagram() {
  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      {/* which side of the wall you are on */}
      <div className="border-border grid border-b lg:grid-cols-3">
        <div className="border-border/70 px-6 py-3 lg:border-r lg:border-dashed">
          <Eyebrow>Inside the sandbox</Eyebrow>
        </div>
        <div className="border-border/70 border-t px-6 py-3 lg:col-span-2 lg:border-t-0">
          <Eyebrow>Server-side · Kortix</Eyebrow>
        </div>
      </div>

      {/* the three steps */}
      <div className="grid lg:grid-cols-3">
        {broker.flow.map((step, i) => (
          <div
            key={step.id}
            className={cn(
              'border-border relative p-6 sm:p-8',
              i > 0 && 'border-t lg:border-t-0 lg:border-l',
              // the wall: dashed only between the sandbox and Kortix
              i === 1 && 'lg:border-dashed',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground/60 font-mono text-[11px] tabular-nums">
                {step.step}
              </span>
              <h3 className="text-foreground text-base font-medium tracking-tight">{step.title}</h3>
            </div>

            <p className="border-border bg-background text-foreground mt-4 overflow-x-auto rounded-sm border px-3 py-2 font-mono text-[11px] whitespace-nowrap">
              {step.mono}
            </p>

            <p className="text-muted-foreground mt-4 text-sm leading-relaxed">{step.body}</p>

            {/* the arrow sits on the seam between two steps, desktop only */}
            {i < broker.flow.length - 1 && (
              <span
                aria-hidden
                className="border-border bg-background text-muted-foreground absolute top-1/2 -right-3 z-10 hidden size-6 -translate-y-1/2 items-center justify-center rounded-full border lg:flex"
              >
                <ArrowRightIcon className="size-3" />
              </span>
            )}
          </div>
        ))}
      </div>

      {/* what never makes it across */}
      <div className="border-border bg-foreground/[0.02] flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-4">
        <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[10px] tracking-widest uppercase">
          <ProhibitIcon aria-hidden className="size-3" />
          {broker.neverLabel}
        </span>
        {broker.never.map((item) => (
          <span
            key={item}
            className="text-muted-foreground/70 font-mono text-[11px] line-through decoration-1"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function BrokerSection() {
  return (
    <Section id="broker">
      <SectionHeader eyebrow={broker.eyebrow} title={broker.title} description={broker.sub} />

      <Reveal delay={0.06}>
        <div className="border-border mt-10 grid overflow-hidden rounded-sm border md:grid-cols-2">
          <EnvPanel
            label={broker.before.label}
            title={broker.before.title}
            lines={broker.before.lines}
            body={broker.before.body}
            muted
          />
          <div className="border-border border-t md:border-t-0 md:border-l">
            <EnvPanel
              label={broker.after.label}
              title={broker.after.title}
              lines={broker.after.lines}
              body={broker.after.body}
            />
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mt-4">
          <FlowDiagram />
        </div>
      </Reveal>

      <Reveal delay={0.14}>
        <Separator className="mt-12" />
        <div className="mt-8 grid gap-8 sm:grid-cols-3">
          {broker.guarantees.map((item) => (
            <div key={item.id}>
              <h3 className="text-foreground text-sm font-medium tracking-tight">{item.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}
