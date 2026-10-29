'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from '@/components/site-link';
import { CodePanel } from '@/features/marketing/code-panel';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { localizeMarketingContent as localizeContent, type TopicId } from './content';
import { Window } from './parts';
import { TopicTabs } from './topic-tabs';

/*
 * One focused visual per buyer topic. Each fits the tab's panel at 390 px:
 * one column, base-size labels, rows that wrap. A topic with a page of its
 * own links there.
 */

const linkClass =
  'text-foreground hover:text-muted-foreground outline-ring duration-normal inline-flex items-center gap-1.5 rounded-sm text-sm underline-offset-4 transition-colors ease-out hover:underline focus-visible:outline-2 focus-visible:outline-offset-2';

function Links({ items }: { items: readonly { label: string; href: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map((l) => (
        <li key={l.href}>
          <Link href={l.href} className={linkClass}>
            {l.label}
            <ArrowRightIcon className="size-3.5" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A bordered list of label and value rows. */
function Rows({ rows }: { rows: readonly { k: string; v: string }[] }) {
  return (
    <ul className="bg-background flex flex-col divide-y rounded-lg border">
      {rows.map((r) => (
        <li key={r.k} className="flex flex-col gap-1 p-4">
          <span className="text-foreground text-base font-medium">{r.k}</span>
          <span className="text-muted-foreground text-sm text-pretty">{r.v}</span>
        </li>
      ))}
    </ul>
  );
}

function DrivePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { driveTree } = localizeContent(tMarketing);

  return (
    <Window title={tMarketing('texte4d812fc9db4')}>
      <ul className="flex flex-col divide-y">
        {driveTree.map((d) => (
          <li
            key={d.path}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3"
          >
            <code className="text-foreground font-mono text-sm">{d.path}</code>
            {d.note ? <span className="text-muted-foreground text-sm">{d.note}</span> : null}
          </li>
        ))}
      </ul>
    </Window>
  );
}

function SpendPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { spendRows } = localizeContent(tMarketing);

  return (
    <Window title={tMarketing('text9218ded06bfa')}>
      <ul className="flex flex-col divide-y">
        {spendRows.map((r) => (
          <li
            key={r.k}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3"
          >
            <span className="text-foreground text-sm">{r.k}</span>
            <span className="text-muted-foreground text-sm">{r.v}</span>
          </li>
        ))}
      </ul>
    </Window>
  );
}

function StepsPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { workSteps } = localizeContent(tMarketing);

  return (
    <ol className="bg-background flex flex-col divide-y rounded-lg border">
      {workSteps.map((s, i) => (
        <li key={s.k} className="flex items-start gap-4 px-4 py-3">
          <span className="text-muted-foreground w-4 shrink-0 pt-0.5 font-mono text-xs tabular-nums">
            {i + 1}
          </span>
          <div className="flex flex-col">
            <span className="text-foreground text-base">{s.k}</span>
            <span className="text-muted-foreground text-sm text-pretty">{s.v}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

const withLinks = (visual: ReactNode, links: readonly { label: string; href: string }[]) => (
  <div className="flex flex-col gap-4">
    {visual}
    <Links items={links} />
  </div>
);

const PANELS: Record<TopicId, () => ReactNode> = {
  rollout: () => <DrivePanel />,
  infra: function InfraPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { deployments } = localizeContent(tMarketing);
    return withLinks(<Rows rows={deployments} />, [
      { label: tMarketing('textb817cbd4d6df'), href: '/self-hosted' },
      { label: tMarketing('texta3df7e7a4b22'), href: '/sovereign' },
    ]);
  },
  models: () => <SpendPanel />,
  governance: function GovernancePanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { governanceRows } = localizeContent(tMarketing);
    return withLinks(<Rows rows={governanceRows} />, [
      { label: tMarketing('text4a109cc49467'), href: '/compliance' },
      { label: tMarketing('text43d612db102b'), href: '/security' },
    ]);
  },
  build: function BuildPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { buildLines } = localizeContent(tMarketing);
    return withLinks(<CodePanel title={buildLines.title} lines={buildLines.lines} lang="sh" />, [
      { label: tMarketing('text9a144533fc45'), href: '/framework' },
      { label: tMarketing('text68cfb8137789'), href: '/docs/developers' },
    ]);
  },
  work: () => <StepsPanel />,
};

/** The how-it-works tabs, one per buyer topic. */
export function EnterpriseTopics() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { topics } = localizeContent(tMarketing);

  return <TopicTabs topics={topics} panels={PANELS} label={tMarketing('text9fbef1119224')} />;
}
