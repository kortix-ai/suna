'use client';

import Link from '@/components/site-link';
import { BeamsBackdrop } from '@/components/ui/paper-wallpaper-shaders';
import { PRICING_PLANS } from '@/features/billing/pricing-plans';
import { useOsContent } from './use-os-content';
import { CardArrow, Heading, PillLink, Section } from './primitives';

/** Developers: the two commands, and where to read more. */
export function Developers() {
  const { developers } = useOsContent();
  return (
    <Section className="grid gap-12 lg:grid-cols-2 lg:items-center">
      <div className="space-y-6">
        <span className="text-muted-foreground font-mono text-xs uppercase">{developers.eyebrow}</span>
        <Heading>{developers.title}</Heading>
        <p className="text-muted-foreground max-w-xl text-lg leading-relaxed text-pretty">{developers.body}</p>
        <div className="flex flex-wrap gap-3">
          <PillLink href={developers.cta.href}>{developers.cta.label}</PillLink>
          <PillLink tone="outline" href={developers.secondary.href}>
            {developers.secondary.label}
          </PillLink>
        </div>
      </div>
      <pre className="dark bg-background text-foreground border-border rounded-xl border p-8 font-mono text-base leading-loose">
        {developers.lines.join('\n')}
      </pre>
    </Section>
  );
}

/** "Built for the enterprise": a title, then one row per guarantee. */
export function EnterpriseRows() {
  const { enterpriseRows } = useOsContent();
  return (
    <Section>
      <div className="max-w-3xl space-y-4">
        <Heading>{enterpriseRows.title}</Heading>
        <p className="text-muted-foreground text-3xl font-normal tracking-tight text-balance sm:text-5xl">
          {enterpriseRows.sub}
        </p>
      </div>
      <dl className="mt-16">
        {enterpriseRows.rows.map((row) => (
          <div key={row.title} className="border-border grid gap-4 border-t py-10 md:grid-cols-2 md:py-14">
            <dt className="text-foreground text-2xl font-normal tracking-tight">{row.title}</dt>
            <dd className="text-muted-foreground max-w-md text-base leading-relaxed md:justify-self-end">{row.body}</dd>
          </div>
        ))}
      </dl>
      <PillLink tone="outline" href={enterpriseRows.cta.href} className="mt-4 w-fit">
        {enterpriseRows.cta.label}
      </PillLink>
    </Section>
  );
}

/** Product-led: the three plans, read from the one pricing source. */
export function Plans() {
  const { plans } = useOsContent();
  return (
    <Section>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <Heading className="max-w-2xl">{plans.title}</Heading>
        <Link href={plans.more.href} className="text-foreground text-sm underline underline-offset-4">
          {plans.more.label}
        </Link>
      </div>
      <ul className="mt-12 grid gap-4 md:grid-cols-3">
        {PRICING_PLANS.map((plan) => (
          <li key={plan.id} className="border-border flex flex-col gap-6 rounded-xl border p-8">
            <span className="text-muted-foreground text-sm">{plan.name}</span>
            <span className="text-foreground text-5xl font-normal tracking-tight">
              {plan.price}
              {plan.unit ? <span className="text-muted-foreground ml-2 text-base">{plan.unit}</span> : null}
            </span>
            <p className="text-muted-foreground text-base text-pretty">{plan.note}</p>
            <ul className="text-foreground mt-auto space-y-2 text-sm">
              {plan.features.slice(0, 3).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The team. The footer carries the close. */
export function Team() {
  const { team } = useOsContent();
  return (
    <section className="dark bg-background text-foreground relative overflow-hidden">
      <BeamsBackdrop fade="band" />
      <div className="relative mx-auto w-full max-w-7xl px-6 py-24 md:py-30">
        <div className="grid gap-6 lg:grid-cols-2 lg:items-end">
          <Heading>{team.title}</Heading>
          <p className="text-muted-foreground max-w-md text-lg text-pretty lg:justify-self-end">{team.body}</p>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-[3fr_2fr]">
          {team.cards.map((card, i) => (
            <Link
              key={card.href}
              href={card.href}
              className={
                i === 0
                  ? 'group bg-foreground text-background flex min-h-72 items-end justify-between rounded-xl p-8'
                  : 'group bg-foreground/10 text-foreground border-border flex min-h-72 items-end justify-between rounded-xl border p-8 backdrop-blur-md'
              }
            >
              <span className="text-3xl font-normal tracking-tight">{card.title}</span>
              <CardArrow />
            </Link>
          ))}
        </div>

      </div>
    </section>
  );
}
