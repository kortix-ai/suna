'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { CaseStudies } from '@/features/marketing/case-studies/case-studies';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, PageFrame } from '@/features/marketing/kit/page-frame';
import { FaqSection } from '@/features/marketing/landing-sections/faq-section';
import {
  benefits,
  caseCta,
  closing,
  compare,
  faq,
  functions,
  GUARANTEE,
  hero,
  intro,
  onboarding,
  platform,
  PRICE,
  pricing,
  stages,
} from '@/features/marketing/services/content';
import { cn } from '@kortix/ui';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import {
  ArrowRightIcon,
  GitBranchIcon,
  GraduationCapIcon,
  PathIcon,
  ReceiptIcon,
  StackIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import Image from 'next/image';
import Link from 'next/link';
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

/** A third-party logo is drawn for a white ground: white in both themes (color.md, logo tile rule). */
const LOGO_TILE_BACKGROUND = 'bg-white';

const BENEFIT_ICONS = {
  team: UsersThreeIcon,
  flat: ReceiptIcon,
  path: PathIcon,
  os: StackIcon,
  repo: GitBranchIcon,
  cloud: GraduationCapIcon,
} as const;

/** "Join now": the Stripe checkout when it is configured, else the intro call. */
function JoinButton({
  variant,
  className,
}: {
  variant?: 'primary' | 'secondary';
  className?: string;
}) {
  const openDemo = useRequestDemo();
  if (!CHECKOUT_URL) {
    return (
      <MarketingButton
        size="md"
        variant={variant}
        className={className}
        onClick={() => openDemo({ source: 'services' })}
      >
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

/** The team you meet on the call: faces cut from the /about team photo. */
function TeamFaces() {
  return (
    <span aria-hidden className="flex -space-x-3">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <Image
          key={n}
          src={`/images/team/face-${n}.webp`}
          alt=""
          width={80}
          height={80}
          className="ring-card size-14 rounded-full ring-4"
        />
      ))}
    </span>
  );
}

function IntroButton({
  variant = 'secondary',
  className,
}: {
  variant?: 'primary' | 'secondary';
  className?: string;
}) {
  const openDemo = useRequestDemo();
  return (
    <MarketingButton
      size="md"
      variant={variant}
      className={className}
      onClick={() => openDemo({ source: 'services' })}
    >
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
      {/* ── hero: one promise, one ask, the logos ──────────────────────────── */}
      <section
        id="hero"
        className="relative overflow-hidden px-6 pt-32 pb-16 lg:px-28 lg:pt-40 lg:pb-20"
      >
        {/* The brand's dither field over the top band, faded out before the
            title (same masks as the closing call to action). It stays
            between the two rails, clipped there, never across them. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-4 top-0 h-81.5 overflow-hidden [mask-image:linear-gradient(to_bottom,#000,transparent_150px),radial-gradient(50%_300px_at_50%_0,#000,transparent)] lg:inset-x-17"
        >
          <DitherField />
        </div>
        <div className="relative mx-auto flex max-w-5xl flex-col items-center gap-6 text-center">
          <h1 className="text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            <span className="text-foreground block">{hero.title}</span>
            <span className="text-muted-foreground block">{hero.titleMuted}</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg">
            {hero.sub}
          </p>
          <div className="flex flex-wrap justify-center gap-2.5 pt-2">
            <IntroButton variant="primary" className="hit-area-y-1" />
            <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
              <a href="#pricing">See pricing</a>
            </MarketingButton>
          </div>
          <p className="text-muted-foreground text-sm text-pretty">{hero.terms}</p>
        </div>

        <div className="relative mt-14 flex flex-wrap items-center justify-center gap-3">
          <span className="text-muted-foreground text-sm">{hero.logosLabel}</span>
          {hero.logos.map((logo) => (
            <span
              key={logo.alt}
              className={cn(LOGO_TILE_BACKGROUND, 'flex h-12 items-center rounded-md border px-4')}
            >
              <Image
                src={logo.src}
                alt={logo.alt}
                width={logo.width}
                height={logo.height}
                unoptimized
                // A stacked mark (CityU) reads small at a wordmark's height.
                className={logo.width / logo.height > 2.5 ? 'h-6 w-auto' : 'h-9 w-auto'}
              />
            </span>
          ))}
          <a
            href="#case-studies"
            className="text-foreground hover:text-muted-foreground outline-ring duration-normal inline-flex items-center gap-1.5 rounded-sm text-sm font-medium transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {hero.logosLink}
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </a>
        </div>
      </section>

      {/* ── how it works: join, map, ship (designjoy's three steps) ─────── */}
      <Block id="how-it-works">
        <Heading title={onboarding.title} titleMuted={onboarding.titleMuted} />
        <Band className="mt-12">
          <CellGrid items={onboarding.items} cols="lg:grid-cols-3" />
        </Band>
      </Block>

      {/* ── what we do: map, unify, automate, build, teach ──────────────── */}
      <Block id="how">
        <Heading title={stages.title} titleMuted={stages.titleMuted} />
        <Band className="mt-12">
          <ol className="divide-y">
            {stages.items.map((stage) => (
              <li
                key={stage.id}
                className="grid grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-12 lg:gap-8 lg:px-11 lg:py-10"
              >
                <div className="flex flex-col gap-3 lg:col-span-3">
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {stage.n}
                  </span>
                  <h3 className="text-foreground text-xl font-medium tracking-tight">{stage.k}</h3>
                </div>
                {/* The description runs the full width; what you get sits under it. */}
                <div className="flex flex-col gap-5 lg:col-span-9">
                  <p className="text-muted-foreground text-base text-pretty">{stage.v}</p>
                  <ul className="flex flex-col gap-x-8 gap-y-2 text-sm sm:flex-row sm:flex-wrap">
                    {stage.get.map((item) => (
                      <li key={item} className="text-foreground flex items-start gap-2">
                        <SolidCheckIcon className="text-ring mt-0.5" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </Band>
      </Block>

      <CaseStudies allLink />
      <div className="flex flex-col items-start gap-5 px-8 pb-8 sm:flex-row sm:items-center sm:justify-between lg:px-28">
        <p className="text-foreground text-lg font-medium text-balance">{caseCta}</p>
        <div className="flex flex-wrap gap-2.5">
          <IntroButton variant="primary" />
          <JoinButton variant="secondary" />
        </div>
      </div>

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

      {/* ── built on Kortix: what everything runs on ───────────────────── */}
      <FeatureSplit
        id="platform"
        title={platform.title}
        titleMuted={platform.titleMuted}
        body={platform.body}
        cells={platform.cells}
        after={
          <div className="px-8 pt-6 lg:px-28">
            <Link
              href="/"
              className="text-foreground hover:text-muted-foreground outline-ring duration-normal inline-flex items-center gap-1.5 rounded-sm text-sm font-medium transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {platform.link}
              <ArrowRightIcon aria-hidden className="size-3.5" />
            </Link>
          </div>
        }
      />

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
                    className={cn(
                      'w-1/4 px-4 py-4 font-medium',
                      i === 0 ? 'bg-muted text-foreground rounded-t-md' : 'text-muted-foreground',
                    )}
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
                    <td
                      key={cell}
                      className={cn(
                        'px-4 py-4 text-pretty',
                        i === 0 ? 'bg-muted text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {i === 0 ? (
                        <span className="flex items-start gap-2">
                          <SolidCheckIcon className="text-ring mt-0.5" />
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
        {/* Both cards carry the toast's smooth shadow ring (shadow.floriankiem.com
            `ring-sm`) instead of a flat border, share one padding, and end on
            their button, so Join now and Book an intro call sit on one line. */}
        <div className="mt-12 grid grid-cols-1 gap-4 px-8 lg:grid-cols-[3fr_2fr] lg:px-28">
          <div className="bg-foreground text-background smooth-shadow-ring-sm flex flex-col gap-6 rounded-lg p-8 lg:p-10">
            <h3 className="text-lg font-medium">{pricing.plan}</h3>
            <Price />
            <p className="text-sm text-pretty opacity-70">{pricing.lock}</p>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-current/20 pt-6 text-sm sm:grid-cols-2">
              {pricing.includes.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <SolidCheckIcon className="text-ring mt-0.5" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="text-xs text-pretty opacity-70">
              {pricing.secure}. {GUARANTEE}
            </p>
            <JoinButton variant="secondary" className="mt-auto w-full" />
          </div>
          <div className="bg-card smooth-shadow-ring-sm flex flex-col gap-6 rounded-lg p-8 lg:p-10">
            <div>
              <h3 className="text-foreground text-lg font-medium">{intro.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm text-pretty">{intro.body}</p>
            </div>
            <div className="flex flex-1 items-center">
              <TeamFaces />
            </div>
            <IntroButton className="mt-auto w-full" />
          </div>
        </div>
      </Block>

      {/* ── objections: the home page FAQ, with these questions ─────────── */}
      <FaqSection
        title={faq.title}
        titleMuted={faq.titleMuted}
        items={faq.items.map((item) => ({
          id: `faq-${item.id}`,
          question: item.q,
          answer: item.a,
        }))}
      />

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
