'use client';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { localizeUiCatalog } from '@kortix/ui/i18n';

import Link from '@/components/site-link';
import { YamlLine } from '@/features/marketing/code-panel';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { cn } from '@kortix/ui';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  CalendarBlankIcon,
  CheckIcon,
  FileTextIcon,
  GitBranchIcon,
  RobotIcon,
  TerminalIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { localizeMarketingContent as localizeModel, type Excerpt, type WalkStep } from './model';

/*
 * The /framework hero, in the home page's SandBandHero layout: the two-tone
 * title and one sentence on white, then a band with one visual. Left, a part
 * of the Arcadia kortix.yaml; right, what Kortix runs from it. The step strip
 * walks four steps (declare, connect, trigger, ship) every 4.5 s until a
 * reader picks one (never with reduced motion). Sample data: Arcadia.
 */

const STEP_MS = 4500;
const fade = 'animate-in fade-in duration-slower ease-out';
const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function Pane({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-background flex w-full min-w-0 flex-col overflow-hidden rounded-lg border">
      <div className="text-muted-foreground flex items-center gap-2 border-b px-4 py-3 font-mono text-xs">
        {icon}
        <span className="truncate">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** MANIFEST lines with their real line numbers; the focused block marked. */
function YamlExcerpt({ excerpt }: { excerpt: Excerpt }) {
  const [from, to] = excerpt.focus;
  return (
    <ol className="overflow-x-auto py-3 font-mono text-xs leading-6 lg:text-sm lg:leading-7">
      {excerpt.lines.map((line, i) => {
        const on = i >= from && i <= to;
        return (
          <li
            key={`${excerpt.start + i}`}
            className={cn(
              'flex gap-4 border-l-2 pr-5 pl-3 whitespace-pre-wrap lg:min-w-max lg:whitespace-pre',
              on ? 'bg-muted border-foreground' : 'border-transparent opacity-50',
            )}
          >
            <span
              aria-hidden
              className="text-muted-foreground w-5 shrink-0 text-right tabular-nums select-none"
            >
              {excerpt.start + i + 1}
            </span>
            <span className="min-w-0 break-words">
              {line === '' ? ' ' : <YamlLine line={line} />}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Terminal({ lines }: { lines: readonly string[] }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-4 font-mono text-xs leading-6 lg:text-sm lg:leading-7">
      {lines.map((line) =>
        line.startsWith('$') ? (
          <p key={line} className="text-foreground">
            <span className="text-muted-foreground select-none">$</span>
            {line.slice(1)}
          </p>
        ) : (
          <p key={line} className="text-kortix-green whitespace-pre">
            {line}
          </p>
        ),
      )}
    </div>
  );
}

function Chips({ items, mono = false }: { items: readonly string[]; mono?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li
          key={item}
          className={cn(
            'bg-muted text-foreground rounded-md px-2 py-0.5 text-sm',
            mono && 'font-mono text-xs leading-5',
          )}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={caption}>{k}</span>
      {children}
    </div>
  );
}

/* What Kortix runs from each excerpt, drawn like the product's own surfaces. */

function AgentCard() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-3">
        <span className="bg-muted flex size-9 items-center justify-center rounded-md">
          <RobotIcon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-foreground font-mono text-sm font-medium">
            {tMarketing('textc055fa5fff72')}
          </p>
          <p className="text-muted-foreground text-sm">{tMarketing('textf98ee81bceda')}</p>
        </div>
      </div>
      <Row k="Tools">
        <Chips items={['read', 'grep', 'glob', 'web_search']} mono />
      </Row>
      <Row k="Connectors">
        <Chips items={['github', 'kortix_slack']} mono />
      </Row>
      <Row k="Skills">
        <Chips items={['triage-issue']} mono />
      </Row>
      <p className="text-muted-foreground flex items-center gap-2 border-t pt-4 text-sm">
        <GitBranchIcon className="size-4 shrink-0" aria-hidden />
        {tMarketing('text9fad6f07633c')}
      </p>
    </div>
  );
}

function ApprovalCard() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { shipped } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="text-foreground font-mono text-sm">linkedin.create_post</code>
        <span className="bg-kortix-yellow/15 text-foreground inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-medium">
          <span aria-hidden className="bg-kortix-yellow size-1.5 rounded-full" />
          {tMarketing('textdb0e960b68b5')}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground font-mono text-xs leading-5">
          {tMarketing('textd4f0bc5a29de')}
        </dt>
        <dd className="text-foreground font-mono text-xs leading-5">
          {tMarketing('texte2a530e251d3')}
        </dd>
        <dt className="text-muted-foreground font-mono text-xs leading-5">
          {tMarketing('text982d9e3eb996')}
        </dt>
        <dd className="text-foreground min-w-0">{tMarketing('textde7ebd226449')}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {/* A picture of the card, not a control: the labels are not buttons. */}
        <span className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium">
          {tMarketing('text6007acbe30b2')}
        </span>
        <span className="text-foreground rounded-md border px-3 py-1.5 text-sm font-medium">
          {tMarketing('text05a2d7332eb9')}
        </span>
        <span className="text-muted-foreground ms-auto text-xs">
          {tMarketing('textdd9f8e935ed2')}
        </span>
      </div>
      <p className="text-muted-foreground text-sm">{tMarketing('text66a1e0999795')}</p>
    </div>
  );
}

function SessionCard() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-2">
        <CalendarBlankIcon className="text-muted-foreground size-4" aria-hidden />
        <span className="text-foreground text-sm font-medium">
          {tMarketing('text0c9edb438b6e')}
        </span>
      </div>
      <div className="flex flex-col gap-3 rounded-md border p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-foreground text-sm font-medium text-pretty">
            {tMarketing('textb8a8023af3cf')}
          </p>
          <span className="text-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <span aria-hidden className="bg-kortix-green size-1.5 rounded-full" />
            {tMarketing('textf4ccae29e1bb')}
          </span>
        </div>
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
          <span>{tMarketing('textb6b779e41308')}</span>
          <span>{tMarketing('texta17bcc0bdbe1')}</span>
        </div>
      </div>
      <p className="text-muted-foreground text-sm">{tMarketing('text62e4d6cd9c52')}</p>
    </div>
  );
}

function ShippedCard() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { shipped } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-4 p-5">
      <p className="text-foreground text-sm font-medium">{tMarketing('text03199169b217')}</p>
      <ul className="flex flex-col divide-y">
        {shipped.map((row) => (
          <li key={row.k} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <span className={caption}>{row.k}</span>
            <span className="text-foreground font-mono text-xs leading-5">{row.v}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <CheckIcon className="text-kortix-green size-4 shrink-0" weight="bold" aria-hidden />
        {tMarketing('text446559c1e209')}
      </p>
    </div>
  );
}

const sourceRESULT: Record<WalkStep['id'], { title: string; body: () => ReactNode }> = {
  agents: { title: 'Customize · Agents', body: () => <AgentCard /> },
  connectors: { title: 'Review · Approvals', body: () => <ApprovalCard /> },
  triggers: { title: 'Sessions', body: () => <SessionCard /> },
  ship: { title: 'Project', body: () => <ShippedCard /> },
};

function Arrow() {
  return (
    <div
      aria-hidden
      className="text-muted-foreground flex justify-center py-3 lg:items-center lg:px-4 lg:py-0"
    >
      <ArrowDownIcon className="size-5 lg:hidden" />
      <ArrowRightIcon className="hidden size-5 lg:block" />
    </div>
  );
}

function Walkthrough() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { RESULT } = localizeUiCatalog(
    { RESULT: sourceRESULT },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
  const { shipTerminal, walk, walkFiles } = localizeModel(tMarketing);

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

  const step = walk[selected];
  const result = RESULT[step.id];

  return (
    <div className="flex w-full max-w-6xl flex-col gap-8 lg:gap-10">
      <div className="flex flex-col items-center gap-5">
        <div
          role="tablist"
          aria-label={tMarketing('textdf4e708536e6')}
          onKeyDown={onKeyDown}
          className="flex flex-wrap justify-center gap-2"
        >
          {walk.map((s, i) => (
            <button
              key={s.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`framework-walk-${s.id}`}
              aria-controls="framework-walk-panel"
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
        <p
          key={step.id}
          className={cn(
            'text-foreground min-h-12 max-w-2xl px-4 text-center text-base text-balance',
            fade,
          )}
        >
          {step.line}
        </p>
      </div>

      <div
        role="tabpanel"
        id="framework-walk-panel"
        aria-labelledby={`framework-walk-${step.id}`}
        className="grid grid-cols-1 lg:min-h-96 lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)] lg:items-stretch"
      >
        <div key={`file-${step.id}`} className={cn('flex min-w-0', fade)}>
          {step.id === 'ship' ? (
            <Pane
              title={tMarketing('text204d33e194d5')}
              icon={<TerminalIcon className="size-4 shrink-0" aria-hidden />}
            >
              <Terminal lines={shipTerminal} />
            </Pane>
          ) : (
            <Pane
              title={tMarketing('textc09203535f8d')}
              icon={<FileTextIcon className="size-4 shrink-0" aria-hidden />}
            >
              <YamlExcerpt excerpt={walkFiles[step.id]} />
            </Pane>
          )}
        </div>
        <Arrow />
        <div key={`result-${step.id}`} className={cn('flex min-w-0', fade)}>
          <Pane
            title={result.title}
            icon={<span aria-hidden className="bg-foreground size-1.5 rounded-full" />}
          >
            {result.body()}
          </Pane>
        </div>
      </div>
    </div>
  );
}

export function FrameworkHero() {
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
            <a href="https://github.com/kortix-ai/suna" target="_blank" rel="noreferrer">
              {tMarketing('text20672423d716')}
            </a>
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" asChild>
            <Link href="/docs/developers#kortixyaml-reference">
              {tMarketing('text6773a5e43e46')}
            </Link>
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
