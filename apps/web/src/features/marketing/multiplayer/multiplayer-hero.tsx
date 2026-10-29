'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { cn } from '@kortix/ui';
import {
  ArrowUpIcon,
  BookOpenTextIcon,
  CheckIcon,
  EnvelopeSimpleIcon,
  FileTextIcon,
  PlusIcon,
  PresentationIcon,
  ShareNetworkIcon,
  UsersIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { localizeMarketingContent as localizeModel } from './model';
import {
  ApprovalCard,
  Chain,
  Divider,
  FADE,
  Initials,
  Prompt,
  Reply,
  StepRow,
} from './session-parts';

/*
 * The /multiplayer hero, in the home page's SandBandHero layout: the two-tone
 * title and one sentence, then a band with one product-like session window.
 * The step strip under it walks one Arcadia session through four moments:
 * started, shared, written in by a second person, approved. Each step keeps
 * what the steps before it added, like a real thread. The strip advances
 * every 4.5 s until a reader picks a step (never with reduced motion).
 */

const STEP_MS = 4500;
/** Inside the last step: how long the approval card waits before a person approves. */
const APPROVE_MS = 1800;

function Sidebar() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const sessions = ['Q3 board pack', 'Weekly pipeline review', 'Vendor contract renewals'];
  return (
    <aside
      aria-hidden
      className="bg-sidebar hidden w-56 shrink-0 flex-col gap-1 border-r p-3 lg:flex"
    >
      <span className="text-foreground px-2 py-1.5 text-sm font-medium">
        {tMarketing('text1265287db3a9')}
      </span>
      <span className="text-foreground flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
        <PlusIcon className="size-4" />
        {tMarketing('textcffdba22adf2')}
      </span>
      <span className="text-muted-foreground mt-4 px-2 text-xs">
        {tMarketing('text6fa3cbf451b2')}
      </span>
      {sessions.map((s, i) => (
        <span
          key={s}
          className={cn(
            'truncate rounded-md px-2 py-1.5 text-sm',
            i === 0 ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground',
          )}
        >
          {s}
        </span>
      ))}
    </aside>
  );
}

function SharePopover() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div
      className={cn(
        'bg-popover absolute top-12 right-3 z-10 flex w-64 flex-col gap-3 rounded-lg border p-3 shadow-lg',
        FADE,
      )}
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-foreground text-sm font-medium">{tMarketing('textbc9424d3f527')}</p>
        <p className="text-muted-foreground text-xs">{tMarketing('textef82bb889266')}</p>
      </div>
      <div className="bg-muted flex items-center gap-2 rounded-md px-2 py-1.5">
        <UsersIcon className="text-muted-foreground size-4" aria-hidden />
        <span className="text-foreground flex-1 text-sm">
          {tMarketing('textb696d75511dc')}
          <span className="text-muted-foreground text-xs">{tMarketing('textc0711810e523')}</span>
        </span>
        <CheckIcon className="size-4" aria-hidden />
      </div>
    </div>
  );
}

/** The held call. It mounts with the last step, waits, then a person approves it. */
function Approval() {
  const reduced = Boolean(useReducedMotion());
  const [approved, setApproved] = useState(reduced);
  useEffect(() => {
    const timer = setTimeout(() => setApproved(true), APPROVE_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <ApprovalCard
        key={approved ? 'approved' : 'ask'}
        className={FADE}
        approved={approved}
        call="gmail.send_email"
        summary="To board@arcadia.example · Q3 board pack"
        by="by Member 3, project manager"
      />
      {approved ? (
        <Chain className={FADE}>
          <StepRow icon={EnvelopeSimpleIcon} verb="Sent" object="gmail.send_email" />
        </Chain>
      ) : null}
    </>
  );
}

/** The thread up to and including `step`. */
function Thread({ step }: { step: number }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const enter = (s: number) => (s === step ? FADE : undefined);
  return (
    <div className="flex flex-col gap-4">
      <Prompt>{tMarketing('textf9f5f4ebf084')}</Prompt>
      <Reply>{tMarketing('texta1aa1d7578ca')}</Reply>
      <Chain>
        <StepRow icon={BookOpenTextIcon} verb="Loaded skill" object="board-pack" />
        <StepRow icon={FileTextIcon} verb="Read" object="Company/Memory/finance.md" />
        <StepRow
          icon={PresentationIcon}
          verb={step >= 2 ? 'Built' : 'Building'}
          object="q3-board-pack.pptx"
          running={step < 2}
        />
      </Chain>
      {step >= 1 ? <Divider className={enter(1)}>{tMarketing('textbb093def7cc3')}</Divider> : null}
      {step >= 2 ? (
        <>
          <Prompt author="Member 2" className={enter(2)}>
            {tMarketing('textdb0fc145a825')}
          </Prompt>
          <Chain className={enter(2)}>
            <StepRow icon={FileTextIcon} verb="Read" object="Company/Finance/forecast-v2.xlsx" />
          </Chain>
          <Reply className={enter(2)}>{tMarketing('texte2ce4e89223b')}</Reply>
        </>
      ) : null}
      {step >= 3 ? <Approval /> : null}
    </div>
  );
}

function SessionWindow({ step }: { step: number }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const shared = step >= 1;
  return (
    <div
      aria-hidden
      className="bg-background flex h-132 w-full overflow-hidden rounded-xl border text-left lg:h-140"
    >
      <Sidebar />
      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
          <span className="text-foreground truncate text-sm">{tMarketing('text23d8ed429fb6')}</span>
          <div className="flex shrink-0 items-center gap-2">
            {shared ? (
              <span className={cn('flex -space-x-1', step === 1 ? FADE : undefined)}>
                {['M1', 'M2', 'M3'].map((p) => (
                  <Initials key={p} label={p} />
                ))}
              </span>
            ) : null}
            <span
              className={cn(
                'text-foreground flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
                step === 1 && 'bg-muted',
              )}
            >
              <ShareNetworkIcon className="size-3.5" />
              {tMarketing('text29887a5ff984')}
            </span>
          </div>
        </header>
        {step === 1 ? <SharePopover /> : null}

        {/* The newest line sits at the bottom, like the app; older lines fade out at the top. */}
        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_3rem)] px-4 pt-4 lg:px-8">
          <div className="mx-auto w-full max-w-xl pb-4">
            <Thread step={step} />
          </div>
        </div>

        <div className="mx-auto w-full max-w-xl px-4 pb-4 lg:px-0">
          <div className="flex items-center gap-2 rounded-xl border px-3 py-2.5">
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
              {tMarketing('text09582e9a6cd0')}
            </span>
            <span className="text-muted-foreground font-mono text-xs">
              {tMarketing('text388f7968512c')}
            </span>
            <span className="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-full">
              <ArrowUpIcon className="size-3.5" />
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function Walkthrough() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { walk } = localizeModel(tMarketing);

  const reduced = Boolean(useReducedMotion());
  const [selected, setSelected] = useState(0);
  const [held, setHeld] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (reduced || held) return;
    const timer = setInterval(() => setSelected((n) => (n + 1) % walk.length), STEP_MS);
    return () => clearInterval(timer);
  }, [reduced, held]);

  const pick = (i: number) => {
    setHeld(true);
    setSelected(i);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + walk.length) % walk.length;
    pick(next);
    tabRefs.current[next]?.focus();
  };

  const current = walk[selected];

  return (
    <div className="flex w-full flex-col items-center gap-8">
      <div
        role="tabpanel"
        id="multiplayer-walk-panel"
        aria-labelledby={`multiplayer-walk-${current.id}`}
        className="w-full max-w-304"
      >
        <SessionWindow step={selected} />
      </div>

      <div className="flex flex-col items-center gap-5">
        <div
          role="tablist"
          aria-label={tMarketing('textbcf7fc48b931')}
          onKeyDown={onKeyDown}
          className="flex flex-wrap justify-center gap-2"
        >
          {walk.map((w, i) => (
            <button
              key={w.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`multiplayer-walk-${w.id}`}
              aria-controls="multiplayer-walk-panel"
              aria-selected={i === selected}
              tabIndex={i === selected ? 0 : -1}
              onClick={() => pick(i)}
              className="text-muted-foreground hover:text-foreground aria-selected:bg-background aria-selected:text-foreground outline-ring duration-normal aria-selected:border-border flex items-center gap-2 rounded-md border border-transparent px-3 py-1.5 text-sm transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span className="font-mono text-xs tabular-nums">{i + 1}</span>
              {w.label}
            </button>
          ))}
        </div>
        <p
          key={current.id}
          className={cn('text-foreground max-w-2xl px-4 text-center text-base text-balance', FADE)}
        >
          {current.line}
        </p>
      </div>
    </div>
  );
}

export function MultiplayerHero() {
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
            <Link href="/docs/guide#teams">{tMarketing('textea9df23bdcb8')}</Link>
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" asChild>
            <Link href="/auth">{tMarketing('textffbda9db2206')}</Link>
          </MarketingButton>
        </div>
      </div>

      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="bg-card flex flex-col items-center gap-7 px-3 py-8 lg:gap-10 lg:px-11 lg:pt-17 lg:pb-10">
          <Walkthrough />
          <p className="text-foreground px-4 text-center text-base font-medium text-balance">
            {hero.caption} <span className="text-muted-foreground">{hero.captionMuted}</span>
          </p>
        </div>
      </div>
    </section>
  );
}
