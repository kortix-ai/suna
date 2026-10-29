import Link from '@/components/site-link';

import { useTranslations } from '@/i18n/use-translations';

import { ArrowRightIcon, CheckIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { localizeMarketingContent as localizeModel, type TopicId } from './model';
import { Terminal, Window } from './parts';

/*
 * One focused visual per topic tab. Each fits the tab's panel at 390 px: one
 * column, base-size labels, lines that wrap.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';
const card = 'bg-background flex flex-col divide-y rounded-lg border';

/** Mono name on the left, plain note on the right; stacks below sm. */
function Row({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <code className="text-foreground font-mono text-sm">{k}</code>
      <span className="text-muted-foreground text-sm text-pretty sm:text-right">{v}</span>
    </li>
  );
}

function WherePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { whereGroups } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-6">
      {whereGroups.map((group) => (
        <div key={group.k} className="flex flex-col gap-3">
          <span className={caption}>{group.k}</span>
          <ul className={card}>
            {group.rows.map((row) => (
              <Row key={row.k} k={row.k} v={row.v} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ReachPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { reachModes } = localizeModel(tMarketing);

  return (
    <ul className={card}>
      {reachModes.map((mode) => (
        <li key={mode.k} className="flex flex-col gap-1.5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-foreground text-base font-medium">{mode.k}</span>
            <code className="text-muted-foreground font-mono text-xs">{mode.flag}</code>
          </div>
          <span className="text-muted-foreground text-sm text-pretty">{mode.v}</span>
          <span className="text-foreground flex items-center gap-1.5 text-sm">
            {mode.sessions ? (
              <CheckIcon className="text-kortix-green size-4" aria-hidden />
            ) : (
              <XIcon className="text-muted-foreground size-4" aria-hidden />
            )}
            {mode.sessions ? tMarketing('textb38485a433ee') : tMarketing('text734901f1b461')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SetupPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { setupSteps } = localizeModel(tMarketing);

  return (
    <ol className={card}>
      {setupSteps.map((step, i) => (
        <li key={step.k} className="flex items-start gap-4 px-4 py-3">
          <span className="text-muted-foreground w-4 shrink-0 pt-0.5 font-mono text-xs tabular-nums">
            {i + 1}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-foreground text-base">{step.k}</span>
            <span className="text-muted-foreground text-sm text-pretty">{step.v}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function EnterprisePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { enterpriseFeatures, enterpriseLines } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-6">
      <Window title={tMarketing('texte6a39a255b29')}>
        <Terminal lines={enterpriseLines} className="p-4" />
      </Window>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {enterpriseFeatures.map((item) => (
          <li key={item} className="text-foreground flex items-start gap-2 text-sm">
            <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {item}
          </li>
        ))}
      </ul>
      <Link
        href="/enterprise"
        className="text-foreground outline-ring flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {tMarketing('textd562671b412d')}
        <ArrowRightIcon className="size-4" aria-hidden />
      </Link>
    </div>
  );
}

function NeedsPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { needs } = localizeModel(tMarketing);

  return (
    <ul className={card}>
      {needs.map((row) => (
        <li
          key={row.k}
          className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-6"
        >
          <span className={`${caption} sm:w-24 sm:shrink-0`}>{row.k}</span>
          <span className="text-foreground text-sm text-pretty">{row.v}</span>
        </li>
      ))}
    </ul>
  );
}

export const TOPIC_PANELS: Record<TopicId, () => ReactNode> = {
  where: () => <WherePanel />,
  reach: () => <ReachPanel />,
  setup: () => <SetupPanel />,
  updates: function UpdatesPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { updateLines } = localizeModel(tMarketing);
    return (
      <Window title={tMarketing('texte6a39a255b29')}>
        <Terminal lines={updateLines} className="p-4" />
      </Window>
    );
  },
  enterprise: () => <EnterprisePanel />,
  needs: () => <NeedsPanel />,
};
