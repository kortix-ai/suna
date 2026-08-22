'use client';

import { Reveal } from '@/components/home/reveal';
import { Separator } from '@/components/ui/separator';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import { policy, type PolicyStateId } from './content';
import { Eyebrow, ProductShot, Section } from './shared';

/**
 * The three policy tints, taken verbatim from the product
 * (`features/workspace/customize/sections/connectors-view.tsx` → POLICY_LABEL).
 * The marketing page and the screenshot beside it must agree on what green,
 * amber and red mean, or the screenshot stops being evidence.
 */
const TINT: Record<PolicyStateId, string> = {
  allow: 'text-kortix-green',
  ask: 'text-kortix-yellow',
  block: 'text-destructive',
};

const DOT: Record<PolicyStateId, string> = {
  allow: 'bg-kortix-green',
  ask: 'bg-kortix-yellow',
  block: 'bg-destructive',
};

function StateCard({
  state,
}: {
  state: (typeof policy.states)[number];
}) {
  return (
    <article className="flex h-full flex-col p-6 sm:p-8">
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('size-1.5 rounded-full', DOT[state.id])} />
        <span className={cn('font-mono text-[11px] tracking-widest uppercase', TINT[state.id])}>
          {state.label}
        </span>
      </div>
      <h3 className="text-foreground mt-4 text-lg leading-tight font-medium tracking-tight">
        {state.verb}
      </h3>
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{state.body}</p>
      <p className="border-border text-muted-foreground mt-6 rounded-sm border px-3 py-2 font-mono text-[11px]">
        {state.example}
      </p>
    </article>
  );
}

/** The hold, drawn as three beats on one rail. */
function PauseTimeline() {
  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      <div className="border-border border-b px-6 py-4 sm:px-8">
        <Eyebrow>{policy.pause.eyebrow}</Eyebrow>
        <h3 className="text-foreground mt-3 text-xl leading-tight font-medium tracking-tight text-balance">
          {policy.pause.title}
        </h3>
        <p className="text-muted-foreground mt-3 max-w-2xl text-sm leading-relaxed">
          {policy.pause.body}
        </p>
      </div>
      <ol className="grid sm:grid-cols-3">
        {policy.pause.steps.map((step, i) => (
          <li
            key={step.id}
            className={cn(
              'border-border px-6 py-6 sm:px-8',
              i > 0 && 'border-t sm:border-t-0 sm:border-l',
            )}
          >
            {/* The rail runs through the centre of every dot and bleeds past the
                cell padding so the three beats read as one line. The card's
                `overflow-hidden` clips it at the outer edge. */}
            <div className="relative flex items-center">
              <span
                aria-hidden
                className="bg-border absolute top-1/2 -right-6 -left-6 hidden h-px sm:-right-8 sm:-left-8 sm:block"
              />
              <span
                aria-hidden
                className={cn(
                  'relative z-10 size-3 rounded-full',
                  i === 1 ? 'bg-kortix-yellow' : 'bg-foreground/25',
                )}
              />
            </div>
            <p className="text-muted-foreground mt-4 font-mono text-[10px] tracking-widest uppercase">
              {step.mono}
            </p>
            <p className="text-foreground mt-2 text-sm leading-relaxed">{step.label}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Argument-level conditions, as a three-row rule table. */
function ConditionTable() {
  return (
    <div className="border-border overflow-hidden rounded-sm border">
      <div className="border-border bg-foreground/[0.02] grid grid-cols-12 gap-4 border-b px-5 py-2.5">
        <span className="text-muted-foreground col-span-4 font-mono text-[10px] tracking-widest uppercase">
          Action
        </span>
        <span className="text-muted-foreground col-span-5 font-mono text-[10px] tracking-widest uppercase">
          When
        </span>
        <span className="text-muted-foreground col-span-3 text-right font-mono text-[10px] tracking-widest uppercase">
          Then
        </span>
      </div>
      {policy.conditions.rows.map((row) => (
        <div
          key={`${row.match}-${row.when}`}
          className="border-border grid grid-cols-12 items-center gap-4 border-b px-5 py-3 last:border-b-0"
        >
          <span className="text-foreground col-span-4 truncate font-mono text-[11px]">
            {row.match}
          </span>
          <span className="text-muted-foreground col-span-5 truncate font-mono text-[11px]">
            {row.when}
          </span>
          <span
            className={cn(
              'col-span-3 text-right font-mono text-[11px] font-medium',
              TINT[row.action],
            )}
          >
            {policy.states.find((s) => s.id === row.action)?.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PolicySection() {
  return (
    <Section id="policy">
      <SectionHeader eyebrow={policy.eyebrow} title={policy.title} description={policy.sub} />

      <Reveal delay={0.06}>
        <div className="border-border bg-card mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-3">
          {policy.states.map((state, i) => (
            <div
              key={state.id}
              className={cn(
                'border-border',
                i > 0 && 'border-t sm:border-t-0 sm:border-l',
              )}
            >
              <StateCard state={state} />
            </div>
          ))}
        </div>
      </Reveal>

      {/* The screenshot carries a FOURTH state the three cards above do not:
          Default. Naming it here is what stops a reader deciding the capture
          disagrees with the copy — and it is where the honest default belongs,
          because an untouched project runs everything. */}
      <Reveal delay={0.08}>
        <p className="text-muted-foreground mt-6 max-w-3xl text-sm leading-relaxed">
          {policy.defaultState}
        </p>
      </Reveal>

      <Reveal delay={0.1}>
        <ProductShot
          src={policy.shot.src}
          alt={policy.shot.alt}
          caption={policy.shot.caption}
          priority
        />
      </Reveal>

      <Reveal delay={0.12}>
        <div className="mt-12">
          <PauseTimeline />
        </div>
      </Reveal>

      <Reveal delay={0.14}>
        <Separator className="mt-12" />
        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h3 className="text-foreground text-lg leading-tight font-medium tracking-tight text-balance">
              {policy.conditions.title}
            </h3>
            <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
              {policy.conditions.body}
            </p>
            <p className="text-muted-foreground mt-4 font-mono text-[11px] leading-relaxed">
              {policy.note}
            </p>
          </div>
          <div className="lg:col-span-7">
            <ConditionTable />
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
