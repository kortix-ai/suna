'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from '@/components/site-link';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { cn } from '@kortix/ui';
import {
  CloudIcon,
  CodeIcon,
  GitBranchIcon,
  KeyIcon,
  PlugIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useReducedMotion } from 'motion/react';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { localizeMarketingContent as localizeContent, type Step } from './content';
import { Terminal, Window } from './parts';

/*
 * The /sovereign hero, in the home page's SandBandHero layout: the two-tone
 * title and one sentence on white, then a band with one product window. The
 * step strip under it walks the four things a customer owns (the code, the
 * server, the model, the files), every 4 s until a reader picks one (never
 * with reduced motion).
 */

const STEP_MS = 4000;

function RepoStep() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { repoTree } = localizeContent(tMarketing);

  return (
    <Window title={tMarketing('text70d13140dd29')}>
      <ul className="flex flex-col divide-y">
        {repoTree.map((row) => (
          <li
            key={row.path}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3 sm:px-6"
          >
            <code className="text-foreground font-mono text-sm">{row.path}</code>
            <span className="text-muted-foreground text-sm">{row.note}</span>
          </li>
        ))}
      </ul>
    </Window>
  );
}

const SOURCE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  keys: KeyIcon,
  chatgpt: PlugIcon,
  custom: CodeIcon,
  managed: CloudIcon,
};

function ModelsStep() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { modelSources } = localizeContent(tMarketing);

  return (
    <Window title={tMarketing('text541a2ff8599c')}>
      <ul className="flex flex-col divide-y">
        {modelSources.map((source) => {
          const Icon = SOURCE_ICONS[source.id];
          return (
            <li key={source.id} className="flex items-center gap-4 px-4 py-3 sm:px-6">
              <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                <Icon className="size-4.5" aria-hidden />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground text-sm font-medium">{source.k}</span>
                <span className="text-muted-foreground text-sm text-pretty">{source.v}</span>
              </div>
              <span className="text-muted-foreground hidden shrink-0 rounded-sm border px-2 py-0.5 text-xs sm:inline">
                {source.tag}
              </span>
            </li>
          );
        })}
      </ul>
    </Window>
  );
}

const STEP_VIEWS: Record<Step['id'], () => ReactNode> = {
  code: () => <RepoStep />,
  server: function ServerPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { startLines } = localizeContent(tMarketing);
    return (
      <Window title={tMarketing('texte6a39a255b29')}>
        <Terminal lines={startLines} className="px-4 py-4 sm:px-6" />
      </Window>
    );
  },
  models: () => <ModelsStep />,
  files: function FilesPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { cloneLines } = localizeContent(tMarketing);
    return (
      <Window title={tMarketing('textcc59c4ac4977')}>
        <Terminal lines={cloneLines} className="px-4 py-4 sm:px-6" />
        <div className="text-muted-foreground flex items-center gap-2 border-t px-4 py-3 text-sm sm:px-6">
          <GitBranchIcon className="size-4 shrink-0" aria-hidden />
          {tMarketing('text0749a8e92dda')}
        </div>
      </Window>
    );
  },
};

function Walkthrough() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { steps } = localizeContent(tMarketing);

  const reduced = Boolean(useReducedMotion());
  const [selected, setSelected] = useState(0);
  const [held, setHeld] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (reduced || held) return;
    const timer = setInterval(() => setSelected((n) => (n + 1) % steps.length), STEP_MS);
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
    const next = (selected + step + steps.length) % steps.length;
    pick(next);
    tabRefs.current[next]?.focus();
  };

  const step = steps[selected];
  const fade = 'animate-in fade-in duration-slower ease-out';

  return (
    <div className="flex w-full flex-col items-center gap-8 lg:gap-10">
      <div
        role="tablist"
        aria-label={tMarketing('texta3df7e7a4b22')}
        onKeyDown={onKeyDown}
        className="flex flex-wrap justify-center gap-2"
      >
        {steps.map((s, i) => (
          <button
            key={s.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`sovereign-walk-${s.id}`}
            aria-controls="sovereign-walk-panel"
            aria-selected={i === selected}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => pick(i)}
            className="text-muted-foreground hover:text-foreground aria-selected:bg-background aria-selected:text-foreground outline-ring duration-normal aria-selected:border-border flex items-center gap-2 rounded-md border border-transparent px-3 py-1.5 text-sm transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <span className="font-mono text-xs tabular-nums">{i + 1}</span>
            {s.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="sovereign-walk-panel"
        aria-labelledby={`sovereign-walk-${step.id}`}
        className="flex w-full max-w-3xl flex-col gap-6"
      >
        {/* A fixed height keeps the band still while the steps change. */}
        <div key={step.id} className={cn('flex min-h-80 flex-col', fade)}>
          {STEP_VIEWS[step.id]()}
        </div>
        <p
          key={`line-${step.id}`}
          className={cn('text-foreground px-4 text-center text-base text-balance', fade)}
        >
          {step.line}
        </p>
      </div>
    </div>
  );
}

export function SovereignHero() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { hero } = localizeContent(tMarketing);

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
            <a href={hero.github.href} target="_blank" rel="noreferrer">
              {hero.github.label}
            </a>
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" asChild>
            <Link href={hero.selfHost.href}>{hero.selfHost.label}</Link>
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
