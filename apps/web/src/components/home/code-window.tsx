'use client';

import { useTranslations } from 'next-intl';

/**
 * CodeWindow — a small tabbed code/terminal viewer for the homepage Tech
 * section. Shows that a Kortix company is just code: kortix.toml config, an
 * opencode agent file, and a one-command deploy. Presentational only.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';

type TabId = 'toml' | 'agent' | 'deploy';

const TABS: { id: TabId; label: string }[] = [
  { id: 'toml', label: 'kortix.toml' },
  { id: 'agent', label: 'support.md' },
  { id: 'deploy', label: 'deploy' },
];

const C = {
  c: 'text-muted-foreground/70', // comment / muted
  s: 'text-emerald-600 dark:text-emerald-400', // string / value
  f: 'text-foreground', // key / ident
};

function Line({ children }: { children: React.ReactNode }) {
  return <div className="leading-relaxed">{children}</div>;
}

function TomlBody() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <Line><span className={C.c}>[project]</span></Line>
      <Line><span className={C.f}>name</span> = <span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line34JsxTextQuotAcmeAgiQuot')}</span></Line>
      <Line>&nbsp;</Line>
      <Line><span className={C.c}>[[triggers.cron]]</span></Line>
      <Line><span className={C.f}>agent</span> = <span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line37JsxTextQuotBriefingQuot')}</span></Line>
      <Line><span className={C.f}>schedule</span> = <span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line38JsxTextQuot08Quot')}</span></Line>
      <Line>&nbsp;</Line>
      <Line><span className={C.c}>[[channels]]</span></Line>
      <Line><span className={C.f}>type</span> = <span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line41JsxTextQuotSlackQuot')}</span> · <span className={C.f}>agent</span> = <span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line41JsxTextQuotSupportQuot')}</span></Line>
      <Line>&nbsp;</Line>
      <Line><span className={C.c}>[connectors]</span></Line>
      <Line><span className={C.f}>required</span> = [<span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line44JsxTextQuotGmailQuot')}</span>, <span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line44JsxTextQuotStripeQuot')}</span>, <span className={C.s}>{tHardcodedUi.raw('componentsHomeCodeWindow.line44JsxTextQuotSlackQuot')}</span>]</Line>
    </>
  );
}

function AgentBody() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <Line><span className={C.c}>{tHardcodedUi.raw('componentsHomeCodeWindow.line52JsxTextOpencodeAgentsSupportMd')}</span></Line>
      <Line><span className={C.c}>---</span></Line>
      <Line><span className={C.f}>name</span>: <span className={C.s}>support</span></Line>
      <Line><span className={C.f}>model</span>: <span className={C.s}>claude-opus-4-7</span></Line>
      <Line><span className={C.f}>skills</span>: [<span className={C.s}>refund-policy</span>, <span className={C.s}>ticket-triage</span>]</Line>
      <Line><span className={C.f}>tools</span>: [<span className={C.s}>gmail</span>, <span className={C.s}>stripe</span>, <span className={C.s}>slack</span>]</Line>
      <Line><span className={C.c}>---</span></Line>
      <Line>&nbsp;</Line>
      <Line><span className={C.f}>{tHardcodedUi.raw('componentsHomeCodeWindow.line60JsxTextYouAreTheSupportAgentForAcmeResolve')}</span></Line>
      <Line><span className={C.f}>{tHardcodedUi.raw('componentsHomeCodeWindow.line61JsxTextTicketsWithFullProductContextAndEscalate')}</span></Line>
      <Line><span className={C.f}>{tHardcodedUi.raw('componentsHomeCodeWindow.line62JsxTextAnythingOver500ForHumanApproval')}</span></Line>
    </>
  );
}

function DeployBody() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <Line><span className={C.c}>{tHardcodedUi.raw('componentsHomeCodeWindow.line70JsxTextKortixDeploy')}</span></Line>
      <Line><span className={C.s}>✓</span> <span className={C.f}>{tHardcodedUi.raw('componentsHomeCodeWindow.line71JsxTextPushedToMain')}</span></Line>
      <Line><span className={C.s}>✓</span> <span className={C.f}>{tHardcodedUi.raw('componentsHomeCodeWindow.line72JsxTextSandboxSnapshotBooted')}</span></Line>
      <Line><span className={C.s}>✓</span> <span className={C.f}>{tHardcodedUi.raw('componentsHomeCodeWindow.line73JsxTextTriggersScheduledChannelsLive')}</span></Line>
      <Line>&nbsp;</Line>
      <Line><span className="inline-flex items-center gap-2 text-foreground"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />{tHardcodedUi.raw('componentsHomeCodeWindow.line75JsxTextAcmeAgiIsRunning247')}</span></Line>
      <Line><span className={C.f}>$ </span><span className="inline-block h-3.5 w-1.5 animate-pulse bg-muted-foreground/40 align-middle" /></Line>
    </>
  );
}

export function CodeWindow({ className }: { className?: string }) {
  const [tab, setTab] = useState<TabId>('toml');
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border bg-card shadow-xl', className)}>
      {/* tab bar */}
      <div className="flex items-center gap-1 border-b border-border/60 bg-muted/40 px-2.5 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-t-lg px-3 py-1.5 font-mono text-xs transition-colors',
              tab === t.id ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* body */}
      <div className="min-h-[260px] px-5 py-4 font-mono text-sm">
        {tab === 'toml' && <TomlBody />}
        {tab === 'agent' && <AgentBody />}
        {tab === 'deploy' && <DeployBody />}
      </div>
    </div>
  );
}
