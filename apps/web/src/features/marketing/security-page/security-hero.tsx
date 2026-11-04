'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { useWalkthrough, WalkPanel, WalkTabs } from '@/features/marketing/kit/walkthrough';
import { cn } from '@kortix/ui';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ShieldCheckIcon,
  UserIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { localizeMarketingContent as localizeModel } from './model';

/*
 * The /security hero, in the home page's SandBandHero layout: the two-tone
 * title and one sentence on white, then a band that holds one visual of the
 * whole model. A person grants an agent access; the agent works on its own
 * computer; what it does leaves through a gate Kortix runs; only then does it
 * reach the resource. The step strip under it walks the five gates, one at a
 * time, every 3.5 s until a reader picks one (never with reduced motion).
 */

const STEP_MS = 3500;

function Arrow() {
  return (
    <div aria-hidden className="text-muted-foreground flex justify-center py-2 lg:px-3 lg:py-0">
      <ArrowDownIcon className="size-5 lg:hidden" />
      <ArrowRightIcon className="hidden size-5 lg:block" />
    </div>
  );
}

function Node({
  label,
  title,
  note,
  icon,
  className,
}: {
  label: string;
  title: ReactNode;
  note: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-background flex min-w-0 flex-col gap-3 rounded-lg border p-5 lg:p-6',
        className,
      )}
    >
      <span className="text-muted-foreground font-mono text-xs tracking-wide uppercase">
        {label}
      </span>
      <div className="text-foreground flex items-center gap-2.5 text-lg font-medium lg:text-xl">
        {icon}
        {title}
      </div>
      <p className="text-muted-foreground text-sm text-pretty">{note}</p>
    </div>
  );
}

function Walkthrough() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { gates } = localizeModel(tMarketing);

  const { selected, pick } = useWalkthrough(gates.length, STEP_MS);

  const gate = gates[selected];
  // The changing words fade in when the step changes (opacity only).
  const fade = 'animate-in fade-in duration-slower ease-out';

  return (
    <div className="flex w-full flex-col gap-8 lg:gap-10">
      <WalkPanel
        idPrefix="security-walk"
        stepId={gate.id}
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.3fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch"
      >
        <Node
          label={tMarketing('text94d7f303df87')}
          icon={<UserIcon className="size-5 shrink-0" aria-hidden />}
          title={tMarketing('text08b041935798')}
          note="Choose which agent may run, and grant it access."
        />
        <Arrow />
        <div className="bg-background flex min-w-0 flex-col gap-3 rounded-lg border border-dashed p-5 lg:p-6">
          <span className="text-muted-foreground font-mono text-xs tracking-wide uppercase">
            {tMarketing('text590bc3fdbbb6')}
          </span>
          <div className="text-foreground text-lg font-medium lg:text-xl">
            {tMarketing('text750a4ad2a8e3')}
          </div>
          <p className="text-muted-foreground text-sm text-pretty">
            {tMarketing('text388893074961')}
          </p>
          <span
            key={gate.id}
            className={cn(
              'bg-muted text-foreground mt-auto self-start rounded-md px-2.5 py-1 text-sm font-medium',
              fade,
            )}
          >
            {gate.action}
          </span>
        </div>
        <Arrow />
        <Node
          label={tMarketing('text0598a57491dd')}
          className="border-foreground"
          icon={<ShieldCheckIcon className="size-5 shrink-0" aria-hidden />}
          title={
            <span key={gate.id} className={fade}>
              {gate.gate}
            </span>
          }
          note={gate.where}
        />
        <Arrow />
        <Node
          label={tMarketing('texteb7a842ff958')}
          title={
            <span key={gate.id} className={fade}>
              {gate.resource}
            </span>
          }
          note="Reached only after the check."
        />
      </WalkPanel>

      <div className="flex flex-col items-center gap-5">
        <WalkTabs
          steps={gates.map((g) => ({ id: g.id, label: g.gate }))}
          idPrefix="security-walk"
          label={tMarketing('text8ee1e1c11369')}
          selected={selected}
          pick={pick}
        />
        <p
          key={gate.id}
          className={cn('text-foreground max-w-2xl px-4 text-center text-base text-balance', fade)}
        >
          {gate.line}
        </p>
      </div>
    </div>
  );
}

export function SecurityHero() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { hero } = localizeModel(tMarketing);

  return (
    <section id="hero" className="relative">
      <div className="relative flex flex-col gap-7.5 px-8 pt-32 pb-18 lg:px-28 lg:pt-40">
        <div className="flex flex-col gap-4 lg:gap-5">
          <h1 className="max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
            <span className="text-foreground block">{hero.title}</span>
            <span className="text-muted-foreground block">{hero.titleMuted}</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">
            {hero.sub}
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5 pt-2">
          <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
            <Link href="/contact">{tMarketing('text1d1d94fb5397')}</Link>
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" asChild>
            <Link href="/docs/guide#security">{tMarketing('textb611a0f8e2eb')}</Link>
          </MarketingButton>
        </div>
      </div>

      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="bg-card flex flex-col items-center gap-7 px-4 py-8 lg:gap-10 lg:px-11 lg:pt-17 lg:pb-10">
          <Walkthrough />
          <p className="text-foreground px-4 text-center text-base font-medium text-balance">
            {hero.caption} <span className="text-muted-foreground">{hero.captionMuted}</span>
          </p>
        </div>
      </div>
    </section>
  );
}
