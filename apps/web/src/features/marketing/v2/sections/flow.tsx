'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { FLOW } from '@/features/marketing/v2/content';
import { Stage } from '@/features/marketing/v2/illustrations';
import { Eyebrow, Heading, Lead, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { Check, GitMerge, GitPullRequest, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

/** From a sentence to a reviewed merge — the four beats of a Kortix session. */
export function FlowSection() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setActive((i) => (i + 1) % FLOW.steps.length), 4500);
    return () => clearInterval(id);
  }, []);

  return (
    <Section id="how-work-lands" className="bg-muted/40 border-border border-y">
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{FLOW.eyebrow}</Eyebrow>
        <Heading lines={FLOW.heading} className="mt-6" />
        <Lead className="mt-5">{FLOW.subheading}</Lead>
      </div>

      <div className="mt-14 grid items-center gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-14">
        <ol className="order-2 lg:order-1">
          {FLOW.steps.map((step, i) => {
            const isActive = i === active;
            return (
              <li key={step.name}>
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    'w-full cursor-pointer border-l-2 py-4 pl-5 text-left transition-colors',
                    isActive ? 'border-kortix-blue' : 'border-border hover:border-foreground/30',
                  )}
                >
                  <p
                    className={cn(
                      'flex items-center gap-2 text-base font-medium transition-colors',
                      isActive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span className="text-muted-foreground/60 font-mono text-xs tabular-nums">
                      0{i + 1}
                    </span>
                    {step.name}
                  </p>
                  {isActive && (
                    <p className="text-muted-foreground mt-2 max-w-sm text-[0.9375rem] leading-relaxed">
                      {step.description}
                    </p>
                  )}
                </button>
              </li>
            );
          })}
        </ol>

        <Stage className="order-1 min-h-[24rem] lg:order-2">
          <div className="absolute inset-0 flex items-center justify-center p-6 sm:p-10">
            {active === 0 && <AskPanel />}
            {active === 1 && <SessionPanel />}
            {active === 2 && <ChangeRequestPanel />}
            {active === 3 && <MergePanel />}
          </div>
        </Stage>
      </div>
    </Section>
  );
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'border-border bg-background w-full max-w-lg overflow-hidden rounded-sm border shadow-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

function AskPanel() {
  return (
    <Panel>
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 text-[12px]">
        <Icon.Slack className="size-3.5" />
        <span className="text-foreground font-medium">#company-ops</span>
      </div>
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-2.5">
          <span className="bg-muted text-foreground flex size-7 shrink-0 items-center justify-center rounded-sm text-[11px] font-semibold">
            M
          </span>
          <div>
            <p className="text-foreground text-[13px] font-semibold">Marko</p>
            <p className="text-muted-foreground mt-0.5 text-[13px]">
              <span className="text-kortix-blue bg-kortix-blue/10 rounded-sm px-1">@Kortix</span>{' '}
              draft the Q3 renewal for Acme and post it here when it&apos;s ready
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <span className="bg-foreground flex size-7 shrink-0 items-center justify-center rounded-sm">
            <KortixLogo size={13} variant="symbol" className="text-background" />
          </span>
          <div>
            <p className="text-foreground text-[13px] font-semibold">Kortix</p>
            <p className="text-muted-foreground mt-0.5 text-[13px]">
              On it — starting a session with <span className="font-mono">go-to-market</span>.
            </p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

const SESSION_LINES = [
  '✓ sandbox booted · 4 vCPU · 8 GB · microVM',
  '✓ agent loaded · go-to-market',
  '✓ skills · renewal-brief',
  '✓ connectors · slack, stripe, crm',
  '→ branch session/renewal-acme',
  '',
  '  reading  memory/accounts/acme.md',
  '  reading  crm · last 3 calls',
  '  writing  sales/renewals/acme.md',
];

function SessionPanel() {
  return (
    <Panel>
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[11px]">
        <Terminal className="size-3" />
        session/renewal-acme
        <span className="text-kortix-blue ml-auto flex items-center gap-1">
          <span className="bg-kortix-blue size-1.5 animate-pulse rounded-full" />
          running
        </span>
      </div>
      <pre className="p-4 font-mono text-[11.5px] leading-relaxed">
        {SESSION_LINES.map((line, i) => (
          <div
            key={`${i}:${line}`}
            className={cn(
              'whitespace-pre',
              line.startsWith('✓')
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
    </Panel>
  );
}

const DIFF = [
  { sign: '+', text: '# Acme — Q3 renewal' },
  { sign: '+', text: '' },
  { sign: '+', text: 'Seats: 120 → 165 (+37%)' },
  { sign: '+', text: 'ARR: $148,000 → $203,500' },
  { sign: '+', text: 'Risk: SSO rollout blocked on SCIM mapping' },
  { sign: '-', text: 'TODO: pull the numbers' },
];

function ChangeRequestPanel() {
  return (
    <Panel>
      <div className="border-border flex items-center gap-2 border-b px-4 py-2.5">
        <GitPullRequest className="text-kortix-orange size-3.5" />
        <span className="text-foreground font-mono text-[12px]">sales/renewals/acme.md</span>
        <span className="bg-kortix-orange/15 text-kortix-orange ml-auto rounded-sm px-1.5 py-0.5 text-[10px] font-medium">
          Needs 1 approval
        </span>
      </div>
      <pre className="p-4 font-mono text-[11.5px] leading-relaxed">
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
      <div className="border-border flex gap-2 border-t p-3">
        <span className="bg-foreground text-background rounded-sm px-3 py-1.5 text-[12px] font-medium">
          Approve
        </span>
        <span className="border-border text-muted-foreground rounded-sm border px-3 py-1.5 text-[12px]">
          Request changes
        </span>
      </div>
    </Panel>
  );
}

function MergePanel() {
  return (
    <Panel>
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[11px]">
        <GitMerge className="text-kortix-green size-3" />
        main
      </div>
      <div className="divide-border divide-y">
        {[
          { file: 'sales/renewals/acme.md', who: 'go-to-market', when: 'just now' },
          { file: 'memory/accounts/acme.md', who: 'go-to-market', when: 'just now' },
          { file: 'memory/accounts/northstar.md', who: 'support-triage', when: '2h ago' },
        ].map((row) => (
          <div key={row.file} className="flex items-center gap-3 px-4 py-3">
            <span className="bg-kortix-green/15 text-kortix-green flex size-5 shrink-0 items-center justify-center rounded-full">
              <Check className="size-3" strokeWidth={3} />
            </span>
            <div className="min-w-0">
              <p className="text-foreground truncate font-mono text-[12px]">{row.file}</p>
              <p className="text-muted-foreground text-[11px]">
                merged by {row.who} · {row.when}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="border-border text-muted-foreground border-t px-4 py-3 text-[12px]">
        The company is one reviewed change better than it was this morning.
      </div>
    </Panel>
  );
}
