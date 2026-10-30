'use client';

import { useTranslations } from '@/i18n/use-translations';

import { cn } from '@kortix/ui';
import {
  CaretRightIcon,
  CheckIcon,
  HashIcon,
  LinkSimpleIcon,
  MinusIcon,
  PresentationIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { localizeMarketingContent as localizeModel } from './model';
import { ApprovalCard, Chain, Initials, Prompt, Reply, StepRow, Verdict } from './session-parts';

/*
 * One tab per topic, in the home page's HowItWorksTabs shape: the heading and
 * the tabs on the left, the selected topic on the right as two sentences over
 * one visual. Every visual is one column, so it reads at 390 px.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function SharePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { shareOptions } = localizeModel(tMarketing);

  return (
    <div className="bg-background flex flex-col rounded-lg border">
      <ul className="flex flex-col divide-y">
        {shareOptions.map((option) => {
          const on = option.id === 'restricted';
          return (
            <li key={option.id} className="flex items-start gap-3 p-4">
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                  on && 'border-foreground',
                )}
              >
                {on ? <span className="bg-foreground size-2 rounded-full" /> : null}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <p className={cn('text-foreground text-base', on && 'font-medium')}>{option.k}</p>
                <p className="text-muted-foreground text-sm">{option.v}</p>
                {on ? (
                  <ul className="flex flex-wrap gap-1.5 pt-1.5">
                    {[tMarketing('text682761f025aa'), 'Finance'].map((who) => (
                      <li
                        key={who}
                        className="bg-muted text-foreground rounded-md px-2.5 py-1 text-sm"
                      >
                        {who}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground flex items-center gap-2 border-t p-4 text-sm">
        <LinkSimpleIcon className="size-4 shrink-0" aria-hidden />
        {tMarketing('text6b7396fbb5d0')}
      </p>
    </div>
  );
}

function TogetherPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="bg-background flex flex-col gap-4 rounded-lg border p-4">
      <Prompt author="Member 1">{tMarketing('text5c33e31b8f6e')}</Prompt>
      <Chain>
        <StepRow icon={PresentationIcon} verb="Building" object="q3-board-pack.pptx" running />
      </Chain>
      <Prompt author="Member 2">{tMarketing('text7c81f4e0c864')}</Prompt>
      <Reply>{tMarketing('text52f18b11567f')}</Reply>
    </div>
  );
}

function ChannelsPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { joinPolicies } = localizeModel(tMarketing);

  const rows = [
    { who: 'M1', name: 'Member 1', text: '@Kortix list this week’s overdue invoices' },
    { who: 'K', name: 'Kortix', text: 'Found 4. The list is in the session.', app: true },
    { who: 'M2', name: 'Member 2', text: '@Kortix send each customer a reminder' },
    { who: 'K', name: 'Kortix', text: 'Waiting for approval to send 4 emails.', app: true },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-background flex flex-col rounded-lg border">
        <p className="text-foreground flex items-center gap-1.5 border-b px-4 py-3 text-sm font-medium">
          <HashIcon className="size-4" aria-hidden />
          {tMarketing('texteab762a03fd9')}
          <span className="text-muted-foreground font-normal">
            {tMarketing('textb9cb66512164')}
          </span>
        </p>
        <ul className="flex flex-col gap-3 p-4">
          {rows.map((r, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <Initials
                label={r.who}
                className={cn('mt-0.5 rounded-md ring-0', r.app && 'bg-muted text-foreground')}
              />
              <div className="flex min-w-0 flex-col">
                <span className="text-foreground text-sm font-medium">
                  {r.name}
                  {r.app ? (
                    <span className="text-muted-foreground ms-1.5 text-xs font-normal">
                      {tMarketing('text0d04bfeb7d64')}
                    </span>
                  ) : null}
                </span>
                <span className="text-foreground text-sm text-pretty">{r.text}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-2">
        <span className={caption}>{tMarketing('textb1ca871c6696')}</span>
        <ul className="bg-background flex flex-col divide-y rounded-lg border">
          {joinPolicies.map((p) => (
            <li key={p.k} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5">
              <span className="text-foreground text-sm font-medium">{p.k}</span>
              <span className="text-muted-foreground text-sm">{p.v}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Ladder({ title, rungs }: { title: string; rungs: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={caption}>{title}</span>
      <ol className="flex flex-wrap items-center gap-1.5">
        {rungs.map((rung, i) => (
          <li key={rung} className="flex items-center gap-1.5">
            <span className="bg-background text-foreground rounded-md border px-3 py-1.5 text-sm">
              {rung}
            </span>
            {i < rungs.length - 1 ? (
              <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5" />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function AccessPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { agentPick, roles } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <Ladder title={tMarketing('textad8cbd037148')} rungs={roles.account} />
        <Ladder title={tMarketing('text93cdb5341490')} rungs={roles.project} />
      </div>
      <div className="bg-background flex flex-col rounded-lg border">
        <div className="flex items-center gap-2.5 border-b p-4">
          <Initials label="M2" />
          <div className="flex min-w-0 flex-col">
            <span className="text-foreground text-sm font-medium">
              {tMarketing('text21963d0fc5c2')}
            </span>
            <span className="text-muted-foreground text-xs">{tMarketing('textac2057b2e12c')}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 p-4">
          <span className="text-foreground text-sm">
            {tMarketing('text279b44d2ab4b')}
            <span className="text-muted-foreground">{tMarketing('text27930926df27')}</span>
          </span>
          <ul className="flex flex-col gap-2">
            {agentPick.map((a) => (
              <li key={a.k} className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    'flex size-4 items-center justify-center rounded-sm border',
                    a.on && 'bg-foreground text-background border-foreground',
                  )}
                >
                  {a.on ? <CheckIcon className="size-3" weight="bold" /> : null}
                </span>
                <span
                  className={cn(
                    'font-mono text-sm',
                    a.on ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {a.k}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ApprovePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="flex flex-col gap-4">
      <ApprovalCard
        approved={false}
        call="gmail.send_email"
        summary="To board@arcadia.example · Q3 board pack"
        by=""
      />
      <ul className="flex flex-wrap gap-2">
        <li>
          <Verdict kind="allow" label={tMarketing('textf32a91808be4')} />
        </li>
        <li>
          <Verdict kind="ask" label={tMarketing('text9071e6bd37b9')} />
        </li>
        <li>
          <Verdict kind="block" label={tMarketing('text60656a88b0cb')} />
        </li>
      </ul>
    </div>
  );
}

function ReachList({
  title,
  items,
  all,
}: {
  title: string;
  items: readonly string[];
  all: boolean;
}) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="bg-background flex flex-col gap-3 rounded-lg border p-4">
      <span className="text-foreground text-base font-medium">{title}</span>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item} className="text-foreground flex items-start gap-2 text-sm">
            <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" weight="bold" />
            {item}
          </li>
        ))}
        {all ? null : (
          <li className="text-muted-foreground flex items-start gap-2 text-sm">
            <MinusIcon aria-hidden className="mt-0.5 size-4 shrink-0" weight="bold" />
            {tMarketing('textef4e1317f506')}
          </li>
        )}
      </ul>
    </div>
  );
}

function PersonalPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { reach } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ReachList title={reach.private.title} items={reach.private.items} all />
        <ReachList title={reach.shared.title} items={reach.shared.items} all={false} />
      </div>
      <p className="text-muted-foreground text-sm">{reach.note}</p>
    </div>
  );
}

const PANELS: Record<string, () => ReactNode> = {
  share: () => <SharePanel />,
  together: () => <TogetherPanel />,
  channels: () => <ChannelsPanel />,
  access: () => <AccessPanel />,
  approve: () => <ApprovePanel />,
  personal: () => <PersonalPanel />,
};

export function TeamTabs() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { tabs } = localizeModel(tMarketing);

  const [selected, setSelected] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const items = tabs.items;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + items.length) % items.length;
    setSelected(next);
    tabRefs.current[next]?.focus();
  };

  const tab = items[selected];

  const Panel = PANELS[tab.id];
  return (
    <section id="how-it-works" className="scroll-mt-16 py-14 lg:py-20">
      <div className="kx-rail-fade relative border-y px-4 lg:px-17">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="px-4 py-12 lg:px-11 lg:py-16 lg:pr-12">
            <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
              {tabs.title}
              <span className="text-muted-foreground block">{tabs.titleMuted}</span>
            </h2>

            <div
              role="tablist"
              aria-label={tMarketing('text935c8dbad7ad')}
              aria-orientation="vertical"
              onKeyDown={onKeyDown}
              className="mt-10 flex flex-col gap-6"
            >
              {items.map((item, i) => (
                <button
                  key={item.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`team-tab-${item.id}`}
                  aria-controls="team-panel"
                  aria-selected={i === selected}
                  tabIndex={i === selected ? 0 : -1}
                  onClick={() => setSelected(i)}
                  className="outline-ring duration-moderate w-full rounded-sm text-left opacity-50 transition-opacity ease-out hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4 aria-selected:opacity-100"
                >
                  <h3 className="text-foreground text-base font-medium text-pretty">
                    {item.title}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-sm text-balance">
                    {item.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div
            role="tabpanel"
            id="team-panel"
            aria-labelledby={`team-tab-${tab.id}`}
            className="bg-card flex items-center justify-center border-t p-6 sm:p-8 lg:border-t-0 lg:border-l lg:p-12"
          >
            <div
              key={tab.id}
              className="animate-in fade-in duration-slower flex w-full max-w-xl min-w-0 flex-col gap-8 ease-out"
            >
              <div className="flex flex-col gap-3">
                <h3 className="text-foreground text-xl font-medium tracking-tight">{tab.title}</h3>
                {tab.body.map((line) => (
                  <p key={line} className="text-muted-foreground text-base text-pretty">
                    {line}
                  </p>
                ))}
              </div>
              {Panel ? <Panel /> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
