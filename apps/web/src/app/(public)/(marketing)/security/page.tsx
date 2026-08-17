import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@/components/ui/separator';
import { BoundaryDiagram } from '@/features/marketing/security-page/boundary-diagram';
import { CodePanel } from '@/features/marketing/security-page/code-panel';
import {
  audit,
  closing,
  control,
  credentials,
  disclosure,
  hero,
  identity,
  isolation,
  landing,
  posture,
} from '@/features/marketing/security-page/content';
import { CredentialFlow } from '@/features/marketing/security-page/credential-flow';
import { PermissionMatrix } from '@/features/marketing/security-page/permission-matrix';
import { SectionHeading } from '@/features/marketing/security-page/section-heading';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Hairlines for a 4-up grid that reflows 1 → 2 → 4 columns. Written per index
 * because the divider a cell needs changes with the breakpoint: cell 3 is a new
 * row at `sm` (top rule) and a new column at `lg` (left rule).
 */
const GRID_4_RULES = [
  '',
  'border-t sm:border-t-0 sm:border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t sm:border-l lg:border-t-0',
] as const;

function SectionDivider(): ReactNode {
  return (
    <div className="mx-auto max-w-7xl px-6">
      <Separator />
    </div>
  );
}

/** A labelled list of key/value rows — the page's workhorse block. */
function RowList({
  rows,
}: {
  rows: readonly { readonly id: string; readonly k: string; readonly v: string }[];
}): ReactNode {
  return (
    <dl className="border-border bg-card overflow-hidden rounded-sm border">
      {rows.map((row, i) => (
        <div
          key={row.id}
          className={cn(
            'border-border grid gap-2 px-6 py-6 sm:grid-cols-12 sm:gap-8 sm:px-8 sm:py-7',
            i > 0 && 'border-t',
          )}
        >
          <dt className="text-foreground font-mono text-[11px] tracking-widest uppercase sm:col-span-4">
            {row.k}
          </dt>
          <dd className="text-muted-foreground text-sm leading-relaxed sm:col-span-8">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * `/security` — the page a security reviewer reads before they will let anyone
 * else in the building use Kortix.
 *
 * Copy lives in `features/marketing/security-page/content.ts` and every claim on
 * it is traced to code in that file's header, including the seven places where
 * a neighbouring page or the `comms` skill says more than the code supports.
 * Read that header before editing a single line here.
 */
export default function SecurityPage(): ReactNode {
  return (
    <div className="bg-background relative">
      {/* ── hero ────────────────────────────────────────────────────────── */}
      <section className="relative px-6 pt-32 pb-12 sm:pt-36">
        <div className="mx-auto max-w-7xl">
          <Reveal>
            <Badge variant="kortix" className="rounded">
              {hero.eyebrow}
            </Badge>
            <h1 className="text-foreground mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
              {hero.title}
            </h1>
            <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">
              {hero.sub}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href={hero.ctaPrimaryHref}>{hero.ctaPrimary}</Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href={hero.ctaSecondaryHref}>{hero.ctaSecondary}</Link>
              </Button>
            </div>
            <p className="text-muted-foreground mt-6 font-mono text-xs tracking-wider uppercase">
              {hero.microline}
            </p>
          </Reveal>

          {/* the four facts the rest of the page proves */}
          <Reveal delay={0.1}>
            <dl className="border-border bg-card mt-14 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
              {hero.specs.map((spec, i) => (
                <div key={spec.k} className={cn('border-border px-5 py-6 sm:px-6', GRID_4_RULES[i])}>
                  <dt className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                    {spec.k}
                  </dt>
                  <dd className="text-foreground mt-2.5 text-sm leading-snug">{spec.v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </section>

      <SectionDivider />

      {/* ── 1 · isolation ───────────────────────────────────────────────── */}
      <section id="isolation" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={isolation.eyebrow} title={isolation.title} sub={isolation.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <BoundaryDiagram />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-4">
            <RowList rows={isolation.rows} />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 2 · credentials ─────────────────────────────────────────────── */}
      <section id="credentials" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading
          eyebrow={credentials.eyebrow}
          title={credentials.title}
          sub={credentials.sub}
        />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <CredentialFlow />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-4">
            <RowList rows={credentials.rows} />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 3 · identity & permissions ──────────────────────────────────── */}
      <section id="identity" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={identity.eyebrow} title={identity.title} sub={identity.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <PermissionMatrix />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8">
              <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                {identity.presets.label}
              </p>
              <div className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-2">
                {(
                  [
                    ['account', identity.presets.account],
                    ['project', identity.presets.project],
                  ] as const
                ).map(([scope, roles]) => (
                  <div key={scope}>
                    <p className="text-muted-foreground/50 font-mono text-[10px] tracking-widest uppercase">
                      {scope}
                    </p>
                    <ul className="mt-3 space-y-3">
                      {roles.map((role) => (
                        <li key={role.k} className="text-sm leading-relaxed">
                          <span className="text-foreground font-medium">{role.k}.</span>{' '}
                          <span className="text-muted-foreground">{role.v}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8">
              <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                {identity.enterprise.label}
              </p>
              <ul className="mt-6 space-y-3">
                {identity.enterprise.items.map((item) => (
                  <li key={item.k} className="text-sm leading-relaxed">
                    <span className="text-foreground font-medium">{item.k}.</span>{' '}
                    <span className="text-muted-foreground">{item.v}</span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground/60 border-border mt-auto border-t pt-5 text-[13px] leading-relaxed">
                {identity.enterprise.note}
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.14}>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[identity.agents, identity.scoping].map((card) => (
              <div
                key={card.title}
                className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
              >
                <h3 className="text-foreground text-lg leading-tight font-medium">{card.title}</h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 4 · control ─────────────────────────────────────────────────── */}
      <section id="control" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={control.eyebrow} title={control.title} sub={control.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="lg:col-span-6">
              <CodePanel title={control.yaml.title} lines={control.yaml.lines} lang="yaml" />
            </div>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-6 lg:auto-rows-fr">
              {control.notes.map((note) => (
                <li
                  key={note.id}
                  className="border-border bg-card flex h-full flex-col rounded-sm border p-6"
                >
                  <p className="text-foreground font-mono text-[11px] tracking-widest uppercase">
                    {note.k}
                  </p>
                  <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{note.v}</p>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 5 · how work lands ──────────────────────────────────────────── */}
      <section id="change-requests" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={landing.eyebrow} title={landing.title} sub={landing.sub} />

        <Reveal delay={0.06}>
          <ol className="border-border mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-4">
            {landing.steps.map((step, i) => (
              <li
                key={step.n}
                className={cn('border-border bg-card flex flex-col p-6 sm:p-7', GRID_4_RULES[i])}
              >
                <span className="text-muted-foreground/45 font-mono text-xs tracking-widest tabular-nums">
                  {step.n}
                </span>
                <h3 className="text-foreground mt-6 text-lg leading-tight font-medium">
                  {step.title}
                </h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 6 · audit ───────────────────────────────────────────────────── */}
      <section id="audit" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={audit.eyebrow} title={audit.title} sub={audit.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <RowList rows={audit.rows} />
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── 7 · deployment & posture ────────────────────────────────────── */}
      <section id="posture" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading eyebrow={posture.eyebrow} title={posture.title} sub={posture.sub} />

        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {posture.deployments.map((item) => (
              <div
                key={item.id}
                className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
              >
                <h3 className="text-foreground text-lg leading-tight font-medium">{item.k}</h3>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{item.v}</p>
              </div>
            ))}
          </div>
        </Reveal>

        {/* The honest half. Nothing here moves without a report in hand. */}
        <Reveal delay={0.1}>
          <div className="border-border bg-card mt-4 rounded-sm border p-6 sm:p-8">
            <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {posture.compliance.label}
            </p>
            <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {posture.compliance.items.map((item) => (
                <div
                  key={item.k}
                  className="border-border flex items-baseline justify-between gap-4 border-t pt-4"
                >
                  <dt className="text-foreground text-sm font-medium">{item.k}</dt>
                  <dd className="text-muted-foreground shrink-0 font-mono text-[11px] tracking-wider uppercase">
                    {item.v}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground border-border mt-6 border-t pt-6 text-sm leading-relaxed">
              {posture.compliance.note}
            </p>
          </div>
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── disclosure ──────────────────────────────────────────────────── */}
      <section id="disclosure" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <SectionHeading
          eyebrow={disclosure.eyebrow}
          title={disclosure.title}
          sub={disclosure.sub}
        />

        <Reveal delay={0.06}>
          <div className="border-border bg-card mt-10 grid overflow-hidden rounded-sm border lg:grid-cols-12">
            <div className="border-border flex flex-col justify-center p-6 sm:p-8 lg:col-span-5 lg:border-r">
              <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                security contact
              </p>
              <a
                href={`mailto:${disclosure.email}`}
                className="text-foreground mt-4 font-mono text-lg underline-offset-4 hover:underline sm:text-xl"
              >
                {disclosure.email}
              </a>
              <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
                {disclosure.credit}
              </p>
            </div>
            <dl className="lg:col-span-7">
              {disclosure.slas.map((sla, i) => (
                <div
                  key={sla.k}
                  className={cn(
                    'border-border flex flex-wrap items-baseline justify-between gap-3 px-6 py-5 sm:px-8',
                    i > 0 ? 'border-t' : 'border-t lg:border-t-0',
                  )}
                >
                  <dt className="text-foreground text-sm font-medium">{sla.k}</dt>
                  <dd className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
                    {sla.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </section>

      {/* ── closing ─────────────────────────────────────────────────────── */}
      <section id="cta" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-6 rounded-sm border p-8 sm:p-12">
            <Badge variant="kortix" className="rounded">
              {closing.eyebrow}
            </Badge>
            <h2 className="text-foreground max-w-2xl text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
              {closing.title}
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">{closing.sub}</p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href={closing.ctaPrimaryHref}>{closing.ctaPrimary}</Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href={closing.ctaSecondaryHref}>{closing.ctaSecondary}</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </section>

      <div className="h-24 sm:h-28" />
    </div>
  );
}
