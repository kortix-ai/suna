'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { Disclosure, DisclosureList } from '@/features/marketing/kit/disclosure';
import { DitherGlyph } from '@/features/marketing/kit/dither-glyph';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, PageFrame, SpecGrid } from '@/features/marketing/kit/page-frame';
import {
  benefits,
  closing,
  compare,
  faq,
  functions,
  GUARANTEE,
  hero,
  intro,
  PRICE,
  pricing,
  proof,
  stages,
} from '@/features/marketing/services/content';
import { cn } from '@kortix/ui';
import {
  CheckIcon,
  CloudIcon,
  CpuIcon,
  GitBranchIcon,
  PathIcon,
  ReceiptIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * `/services`: the AI Transformation sales page. Standalone: the `(sales)`
 * group's shell replaces the site nav. Copy, the commercial terms and the
 * accuracy gate: `features/marketing/services/content.ts`.
 *
 * "Join now" is a Stripe Payment Link (`NEXT_PUBLIC_SERVICES_CHECKOUT_URL`,
 * per environment: test link on local and dev, live link on prod). Without
 * it, "Join now" opens the intro call instead. Every intro call opens the
 * root demo modal with `source: 'services'`.
 *
 * TODO(idea): the hero has no real artifact (kortix-brand magic_trick.md).
 * The idea it lacks is a real adoption report or roadmap excerpt.
 */

const CHECKOUT_URL = process.env.NEXT_PUBLIC_SERVICES_CHECKOUT_URL;

const BENEFIT_ICONS = {
  team: UsersThreeIcon,
  flat: ReceiptIcon,
  path: PathIcon,
  os: CpuIcon,
  repo: GitBranchIcon,
  cloud: CloudIcon,
} as const;

/** "Join now": the Stripe checkout when it is configured, else the intro call. */
function JoinButton({ variant, className }: { variant?: 'primary' | 'secondary'; className?: string }) {
  const openDemo = useRequestDemo();
  if (!CHECKOUT_URL) {
    return (
      <MarketingButton size="md" variant={variant} className={className} onClick={() => openDemo({ source: 'services' })}>
        Join now
      </MarketingButton>
    );
  }
  return (
    <MarketingButton size="md" variant={variant} className={className} asChild>
      <a href={CHECKOUT_URL}>Join now</a>
    </MarketingButton>
  );
}

function IntroButton({ variant = 'secondary', className }: { variant?: 'primary' | 'secondary'; className?: string }) {
  const openDemo = useRequestDemo();
  return (
    <MarketingButton size="md" variant={variant} className={className} onClick={() => openDemo({ source: 'services' })}>
      Book an intro call
    </MarketingButton>
  );
}

function Price({ className }: { className?: string }): ReactNode {
  return (
    <p className={cn('flex flex-wrap items-baseline gap-x-3', className)}>
      <span className="text-5xl font-medium tracking-tight tabular-nums">{PRICE.now}</span>
      <span className="opacity-70">{PRICE.per}</span>
    </p>
  );
}

export default function ServicesPage() {
  return (
    <PageFrame>
      {/* ── hero: the offer, the promise, the intro call ─────────────────── */}
      <section id="hero" className="grid grid-cols-1 items-center gap-12 px-8 pt-32 pb-16 lg:grid-cols-[3fr_2fr] lg:gap-16 lg:px-28 lg:pt-44 lg:pb-24">
        <div className="flex min-w-0 flex-col gap-7">
          <a
            href="#how"
            className="text-foreground hover:bg-muted outline-ring duration-moderate inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-2"
          >
            <UsersThreeIcon className="size-4" aria-hidden />
            {hero.team}
          </a>
          <h1 className="text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            <span className="text-foreground block">{hero.title}</span>
            <span className="text-muted-foreground block">{hero.titleMuted}</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg">{hero.sub}</p>
          <div className="flex flex-wrap gap-2.5">
            <JoinButton className="hit-area-y-1" />
            <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
              <a href="#pricing">See pricing</a>
            </MarketingButton>
          </div>
          <ul className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {hero.assurances.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <CheckIcon className="text-foreground size-4" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-card flex flex-col gap-5 rounded-lg border p-6 lg:p-8">
          <DitherGlyph src="/media/services/team.svg" className="aspect-[15/11] w-28" />
          <div>
            <h2 className="text-foreground text-lg font-medium">{intro.title}</h2>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">{intro.body}</p>
          </div>
          <IntroButton variant="primary" className="w-full" />
        </div>
      </section>

      <Band>
        <SpecGrid items={proof} cols="lg:grid-cols-4" />
      </Band>

      {/* ── what happens: map, unify, automate, build ──────────────────── */}
      <Block id="how">
        <Heading title={stages.title} titleMuted={stages.titleMuted} />
        <Band className="mt-12">
          <ol className="divide-y">
            {stages.items.map((stage) => (
              <li key={stage.id} className="grid grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-12 lg:gap-8 lg:px-11 lg:py-10">
                <div className="flex flex-col gap-3 lg:col-span-3">
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">{stage.n}</span>
                  <h3 className="text-foreground text-xl font-medium tracking-tight">{stage.k}</h3>
                  <p className="text-muted-foreground text-sm">{stage.who}</p>
                </div>
                <p className="text-muted-foreground text-base text-pretty lg:col-span-5">{stage.v}</p>
                <ul className="flex flex-col gap-2 text-sm lg:col-span-4">
                  {stage.get.map((item) => (
                    <li key={item} className="text-foreground flex items-start gap-2">
                      <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </Band>
      </Block>

      {/* ── every function, and what agents take over ────────────────────── */}
      <Block id="functions">
        <Heading title={functions.title} titleMuted={functions.titleMuted} />
        <Band className="mt-12">
          <CellGrid items={functions.items} cols="lg:grid-cols-4" />
          <div className="flex flex-col gap-2 border-t p-6 lg:p-8">
            <h3 className="text-foreground text-base font-medium">{functions.more.k}</h3>
            <p className="text-muted-foreground text-sm text-pretty">{functions.more.v}</p>
          </div>
        </Band>
      </Block>

      {/* ── the alternatives ──────────────────────────────────────────────── */}
      <Block id="compare">
        <Heading title={compare.title} titleMuted={compare.titleMuted} />
        <div className="mt-12 overflow-x-auto px-8 lg:px-28">
          <table className="w-full min-w-160 text-left text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className="w-1/4 py-4 pr-6 font-normal">
                  <span className="sr-only">Compare</span>
                </th>
                {compare.columns.map((col, i) => (
                  <th
                    key={col}
                    scope="col"
                    className={cn('w-1/4 px-4 py-4 font-medium', i === 0 ? 'bg-muted text-foreground rounded-t-md' : 'text-muted-foreground')}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.rows.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0">
                  <th scope="row" className="text-foreground py-4 pr-6 font-medium">
                    {row.k}
                  </th>
                  {row.v.map((cell, i) => (
                    <td key={cell} className={cn('px-4 py-4 text-pretty', i === 0 ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
                      {i === 0 ? (
                        <span className="flex items-start gap-2">
                          <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                          {cell}
                        </span>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      {/* ── membership benefits ───────────────────────────────────────────── */}
      <Block id="benefits">
        <Heading title={benefits.title} titleMuted={benefits.titleMuted} />
        <Band className="mt-12">
          <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
            {benefits.items.map((item) => {
              const Icon = BENEFIT_ICONS[item.icon];
              return (
                <li key={item.id} className="bg-background flex flex-col gap-3 p-6 lg:p-8">
                  <Icon className="text-foreground size-5" aria-hidden />
                  <h3 className="text-foreground text-base font-medium text-pretty">{item.k}</h3>
                  <p className="text-muted-foreground text-sm text-pretty">{item.v}</p>
                </li>
              );
            })}
          </ul>
        </Band>
      </Block>

      {/* ── pricing: one plan, the guarantee, the intro call ──────────────── */}
      <Block id="pricing">
        <Heading title={pricing.title} titleMuted={pricing.titleMuted} />
        <div className="mt-12 grid grid-cols-1 gap-4 px-8 lg:grid-cols-[3fr_2fr] lg:px-28">
          <div className="bg-foreground text-background flex flex-col gap-6 rounded-lg p-8 lg:p-10">
            <h3 className="text-lg font-medium">{pricing.plan}</h3>
            <Price />
            <p className="text-sm text-pretty opacity-70">{pricing.lock}</p>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-current/20 pt-6 text-sm sm:grid-cols-2">
              {pricing.includes.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-3 pt-2">
              <JoinButton variant="secondary" className="w-full" />
              <p className="text-center text-xs opacity-70">
                {pricing.secure}. {GUARANTEE}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div className="bg-card flex flex-1 flex-col gap-4 rounded-lg border p-6 lg:p-8">
              <div>
                <h3 className="text-foreground text-lg font-medium">{intro.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm text-pretty">{intro.body}</p>
              </div>
              <IntroButton className="mt-auto w-full" />
            </div>
          </div>
        </div>
      </Block>

      {/* ── objections ────────────────────────────────────────────────────── */}
      <Block id="faq">
        <Heading title={faq.title} titleMuted={faq.titleMuted} />
        <DisclosureList className="mx-8 mt-10 lg:mx-28">
          {faq.items.map((item) => (
            <Disclosure key={item.id} id={`faq-${item.id}`} name="services-faq" summary={item.q}>
              <p className="text-muted-foreground max-w-3xl text-base text-pretty">{item.a}</p>
            </Disclosure>
          ))}
        </DisclosureList>
      </Block>

      {/* ── the last ask ──────────────────────────────────────────────────── */}
      <Block id="start">
        <div className="flex flex-col items-start gap-6 px-8 lg:px-28">
          <h2 className="text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            <span className="text-foreground block">{closing.title}</span>
            <span className="text-muted-foreground block">{closing.titleMuted}</span>
          </h2>
          <Price className="text-foreground" />
          <div className="flex flex-wrap gap-2.5">
            <JoinButton className="hit-area-y-1" />
            <IntroButton className="hit-area-y-1" />
          </div>
        </div>
      </Block>

      {/* ── phones: the offer stays in reach ──────────────────────────────── */}
      <div className="bg-background fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-4 border-t px-4 py-3 lg:hidden">
        <p className="text-sm">
          <span className="text-foreground font-medium tabular-nums">{PRICE.now}</span>
          <span className="text-muted-foreground">{PRICE.per}</span>
        </p>
        <JoinButton />
      </div>
    </PageFrame>
  );
}
