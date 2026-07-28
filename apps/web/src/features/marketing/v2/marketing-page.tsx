'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { AppPreview } from '@/features/marketing/v2/app-preview';
import type { PageSpec } from '@/features/marketing/v2/pages-content';
import {
  CenterHero,
  Faq,
  FeatureGrid,
  Floating,
  PageCta,
  Showcase,
  SpecList,
  SplitBlock,
  SplitHero,
} from '@/features/marketing/v2/page-kit';
import { cn } from '@/lib/utils';
import { Check, GitMerge, GitPullRequest, Sparkles, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';

/** Renders a whole sub-page from its spec. */
export function MarketingPage({ spec }: { spec: PageSpec }) {
  const showcase = spec.hero.showcase ?? 'none';
  const hero =
    showcase === 'none' ? null : (
      <Showcase height={showcase === 'command-center' ? 'h-[34rem]' : 'h-[28rem]'}>
        <div className="flex h-full items-center justify-center">
          <Visual kind={showcase} />
        </div>
      </Showcase>
    );

  return (
    <main className="bg-background">
      {spec.hero.kind === 'split' ? (
        <SplitHero heading={spec.hero.heading} body={spec.hero.body} reversed={spec.hero.reversed}>
          {hero}
        </SplitHero>
      ) : (
        <CenterHero heading={spec.hero.heading} body={spec.hero.body}>
          {hero}
        </CenterHero>
      )}

      {spec.grid && <FeatureGrid {...spec.grid} />}

      {spec.splits?.map((split) => (
        <SplitBlock
          key={split.heading.join(' ')}
          heading={split.heading}
          body={split.body}
          checks={split.checks}
          tinted={split.tinted}
          reversed={(split as { reversed?: boolean }).reversed}
          visual={
            split.visual && split.visual !== 'none' ? <Visual kind={split.visual} /> : undefined
          }
        />
      ))}

      {spec.specs && <SpecList {...spec.specs} />}
      {spec.faq && <Faq {...spec.faq} />}

      <PageCta {...spec.cta} />
    </main>
  );
}

/* ── the reusable product stills ─────────────────────────────────────────── */

type VisualKind =
  | 'command-center'
  | 'terminal'
  | 'connectors'
  | 'diff'
  | 'agent-detail'
  | 'sessions';

export function Visual({ kind }: { kind: VisualKind }) {
  switch (kind) {
    case 'command-center':
      return (
        <Floating className="h-full w-full">
          <div className="h-full overflow-hidden">
            <AppPreview />
          </div>
        </Floating>
      );
    case 'terminal':
      return <TerminalStill />;
    case 'connectors':
      return <ConnectorOrbit />;
    case 'diff':
      return <DiffStill />;
    case 'agent-detail':
      return <AgentDetail />;
    case 'sessions':
      return <SessionsStill />;
  }
}

const TERM = [
  '$ kortix sessions new --prompt "draft the renewal for Acme"',
  '',
  '✓ sandbox booted · 4 vCPU · 8 GB · microVM',
  '✓ agent loaded · go-to-market',
  '✓ skills · renewal-brief',
  '✓ connectors · slack, stripe, crm',
  '→ branch session/renewal-acme',
  '',
  '  reading  memory/accounts/acme.md',
  '  writing  sales/renewals/acme.md',
  '',
  '✓ change request opened · needs 1 approval',
];

function TerminalStill() {
  return (
    <Floating className="w-full max-w-xl">
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-3 font-mono text-[11px]">
        <Terminal className="size-3.5" />
        kortix — terminal
        <span className="text-kortix-blue ml-auto flex items-center gap-1.5">
          <span className="bg-kortix-blue size-1.5 animate-pulse rounded-full" />
          microVM
        </span>
      </div>
      <pre className="p-5 font-mono text-[11.5px] leading-[1.75]">
        {TERM.map((line, i) => (
          <div
            key={`${i}:${line}`}
            className={cn(
              'whitespace-pre',
              line.startsWith('$')
                ? 'text-foreground'
                : line.startsWith('✓')
                  ? 'text-kortix-green'
                  : line.startsWith('→')
                    ? 'text-kortix-blue'
                    : 'text-muted-foreground',
            )}
          >
            {line || ' '}
          </div>
        ))}
      </pre>
    </Floating>
  );
}

const ORBIT = [Icon.Github, Icon.Slack, Icon.Linear, Icon.Notion, Icon.MicrosoftTeams, Icon.Gmail];

function ConnectorOrbit() {
  return (
    <div className="relative aspect-square w-[72%] max-w-sm" aria-hidden data-a11y-decorative>
      <div className="border-foreground/10 absolute inset-0 rounded-full border" />
      <div className="bg-background absolute top-1/2 left-1/2 flex size-[5rem] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[1.1rem] shadow-[0_8px_30px_-6px_rgba(26,31,46,0.18)]">
        <KortixLogo size={32} variant="symbol" />
      </div>
      {ORBIT.map((Glyph, i) => {
        const angle = (i / ORBIT.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <div
            key={i}
            className="bg-background absolute flex size-14 items-center justify-center rounded-full shadow-[0_6px_18px_-4px_rgba(26,31,46,0.16)]"
            style={{
              left: `calc(50% + ${Math.cos(angle) * 50}%)`,
              top: `calc(50% + ${Math.sin(angle) * 50}%)`,
              transform: 'translate(-50%,-50%)',
            }}
          >
            <Glyph className="size-6" />
          </div>
        );
      })}
    </div>
  );
}

const DIFF = [
  { sign: '+', text: '# Acme — Q3 renewal' },
  { sign: '+', text: 'Seats: 120 → 165 (+37%)' },
  { sign: '+', text: 'ARR: $148,000 → $203,500' },
  { sign: '+', text: 'Risk: SSO blocked on SCIM mapping' },
  { sign: '-', text: 'TODO: pull the numbers' },
];

function DiffStill() {
  return (
    <Floating className="relative w-full max-w-xl">
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <GitPullRequest className="text-kortix-orange size-3.5" />
        <span className="text-foreground font-mono text-[12.5px]">sales/renewals/acme.md</span>
        <span className="bg-kortix-orange/15 text-kortix-orange ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium">
          Needs 1 approval
        </span>
      </div>
      <pre className="p-4 font-mono text-[12px] leading-[1.7]">
        {DIFF.map((line, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre px-2',
              line.sign === '+'
                ? 'bg-kortix-green/10 text-kortix-green'
                : 'bg-destructive/10 text-destructive',
            )}
          >
            {line.sign} {line.text}
          </div>
        ))}
      </pre>
      <div className="border-border flex items-center justify-end gap-2 border-t p-3.5">
        <span className="border-border text-foreground rounded-full border px-4 py-2 text-[13px]">
          Request changes
        </span>
        <span className="bg-foreground text-background flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium">
          <Check className="size-3.5" strokeWidth={3} />
          Approve
        </span>
      </div>
    </Floating>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-muted-foreground text-[13px]">{label}</span>
      <span className="text-foreground flex items-center gap-1.5 text-[13px]">{children}</span>
    </div>
  );
}

function AgentDetail() {
  return (
    <Floating className="w-full max-w-lg">
      <div className="border-border border-b px-5 py-4">
        <p className="text-muted-foreground text-[12px]">Agent</p>
        <p className="text-foreground mt-1 flex items-center gap-2 text-[1.0625rem] font-medium">
          <Sparkles className="text-kortix-blue size-4" />
          go-to-market
        </p>
      </div>
      <div className="divide-border divide-y">
        <Row label="Status">
          <span className="bg-kortix-green/15 text-kortix-green rounded px-1.5 py-0.5 text-[11px]">
            Live
          </span>
        </Row>
        <Row label="Harness">
          <Icon.Claude className="size-3.5" />
          Claude Code
        </Row>
        <Row label="Model">Opus 5</Row>
        <Row label="Skills">
          <span className="border-border rounded border px-1.5 py-0.5 font-mono text-[11px]">
            renewal-brief
          </span>
        </Row>
        <Row label="Connectors">
          <Icon.Slack className="size-3.5" />
          <Icon.Github className="size-3.5" />
          <Icon.Linear className="size-3.5" />
        </Row>
        <Row label="Trigger">
          <span className="font-mono text-[11.5px]">0 8 * * 1-5</span>
        </Row>
        <Row label="Defined in">
          <span className="font-mono text-[11.5px]">agents/go-to-market.md</span>
        </Row>
      </div>
    </Floating>
  );
}

const SESSIONS = [
  { title: 'Draft the renewal for Acme', agent: 'go-to-market', state: 'Running' },
  { title: 'Triage 42 new support threads', agent: 'support-triage', state: 'Running' },
  { title: 'Reconcile the Stripe payouts', agent: 'finance-ops', state: 'Needs review' },
  { title: 'Weekly revenue digest', agent: 'Trigger · 08:00', state: 'Merged' },
];

function SessionsStill() {
  return (
    <Floating className="w-full max-w-md">
      <p className="border-border text-muted-foreground border-b px-4 py-3 text-[13px]">Sessions</p>
      <ul className="divide-border divide-y">
        {SESSIONS.map((s, i) => (
          <li key={s.title} className={cn('px-4 py-3.5', i === 0 && 'bg-accent')}>
            <p className="text-foreground truncate text-[13.5px]">{s.title}</p>
            <p className="text-muted-foreground mt-1 flex items-center gap-2 text-[11.5px]">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  s.state === 'Running'
                    ? 'bg-kortix-blue'
                    : s.state === 'Needs review'
                      ? 'bg-kortix-orange'
                      : 'bg-kortix-green',
                )}
              />
              {s.state} · {s.agent}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground border-border flex items-center gap-2 border-t px-4 py-3 font-mono text-[11px]">
        <GitMerge className="text-kortix-green size-3.5" />
        main
      </p>
    </Floating>
  );
}
