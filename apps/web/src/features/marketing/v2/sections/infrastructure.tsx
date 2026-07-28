'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { FLOW } from '@/features/marketing/v2/content';
import { Display, Lead, MAX_W } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { Check, GitMerge, GitPullRequest, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

const ORBIT = [
  Icon.Github,
  Icon.Slack,
  Icon.Linear,
  Icon.Notion,
  Icon.MicrosoftTeams,
  Icon.Gmail,
];

/** The infrastructure layer — a step rail beside a big gradient panel. */
export function InfrastructureSection() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setActive((i) => (i + 1) % FLOW.steps.length), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <section id="how-work-lands" className="scroll-mt-24 py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="mx-auto max-w-2xl text-center">
          <Display lines={FLOW.heading} />
          <Lead className="mt-6">{FLOW.subheading}</Lead>
        </div>

        <div className="mt-16 grid items-center gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:gap-12">
          <ol className="order-2 lg:order-1">
            {FLOW.steps.map((step, i) => {
              const isActive = i === active;
              return (
                <li key={step.name}>
                  <button
                    type="button"
                    onClick={() => setActive(i)}
                    className={cn(
                      'w-full cursor-pointer border-l-2 py-5 pl-6 text-left transition-colors',
                      isActive ? 'border-kortix-blue' : 'border-border hover:border-foreground/25',
                    )}
                  >
                    <p
                      className={cn(
                        'text-[1.0625rem] font-medium transition-colors',
                        isActive ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {step.name}
                    </p>
                    {isActive && (
                      <p className="text-muted-foreground mt-2 max-w-[22rem] text-[0.9375rem] leading-[1.55]">
                        {step.description}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          <div
            className="relative order-1 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-[1.5rem] p-8 lg:order-2 lg:aspect-[16/11]"
            style={{
              background:
                'linear-gradient(155deg, color-mix(in oklab, var(--kortix-blue) 5%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 22%, var(--background)) 100%)',
              border: '1px solid color-mix(in oklab, var(--kortix-blue) 12%, transparent)',
            }}
          >
            {active === 0 && <ContextOrbit />}
            {active === 1 && <ExecutionPanel />}
            {active === 2 && <OutputPanel />}
            {active === 3 && <ApprovalPanel />}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── 01 · context ────────────────────────────────────────────────────────── */

function ContextOrbit() {
  return (
    <div className="relative aspect-square w-[74%]" aria-hidden data-a11y-decorative>
      <div className="border-foreground/10 absolute inset-0 rounded-full border" />
      <div className="bg-background absolute top-1/2 left-1/2 flex size-[5.5rem] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[1.1rem] shadow-[0_8px_30px_-6px_rgba(26,31,46,0.18)]">
        <KortixLogo size={34} variant="symbol" />
      </div>
      {ORBIT.map((Glyph, i) => {
        const angle = (i / ORBIT.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <div
            key={i}
            className="bg-background absolute flex size-16 items-center justify-center rounded-full shadow-[0_6px_18px_-4px_rgba(26,31,46,0.16)]"
            style={{
              left: `calc(50% + ${Math.cos(angle) * 50}%)`,
              top: `calc(50% + ${Math.sin(angle) * 50}%)`,
              transform: 'translate(-50%,-50%)',
            }}
          >
            <Glyph className="size-7" />
          </div>
        );
      })}
    </div>
  );
}

/* ── shared floating card ────────────────────────────────────────────────── */

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'bg-background w-full max-w-xl overflow-hidden rounded-[0.9rem] shadow-[0_18px_50px_-12px_rgba(26,31,46,0.22)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── 02 · execution ──────────────────────────────────────────────────────── */

const RUN = [
  '$ kortix sessions new --prompt "draft the renewal for Acme"',
  '',
  '✓ sandbox booted · 4 vCPU · 8 GB · microVM',
  '✓ agent loaded · go-to-market',
  '✓ skills · renewal-brief',
  '✓ connectors · slack, stripe, crm',
  '→ branch session/renewal-acme',
  '',
  '  reading  memory/accounts/acme.md',
  '  reading  crm · last 3 calls with Acme',
  '  writing  sales/renewals/acme.md',
];

function ExecutionPanel() {
  return (
    <Card>
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-3 font-mono text-[11px]">
        <Terminal className="size-3.5" />
        session/renewal-acme
        <span className="text-kortix-blue ml-auto flex items-center gap-1.5">
          <span className="bg-kortix-blue size-1.5 animate-pulse rounded-full" />
          running
        </span>
      </div>
      <pre className="p-5 font-mono text-[12px] leading-[1.75]">
        {RUN.map((line, i) => (
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
    </Card>
  );
}

/* ── 03 · output ─────────────────────────────────────────────────────────── */

const OUTPUT = [
  { file: 'sales/renewals/acme.md', meta: '3 hours ago · Slack · go-to-market', add: 143, del: 11 },
  { file: 'memory/accounts/acme.md', meta: '3 hours ago · Slack · go-to-market', add: 42, del: 6 },
  { file: 'ops/weekly-digest.md', meta: '8 hours ago · Trigger · finance-ops', add: 88, del: 0 },
];

function OutputPanel() {
  return (
    <Card>
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <GitPullRequest className="text-kortix-orange size-3.5" />
        <span className="text-foreground text-[13px] font-medium">Change requests</span>
        <span className="text-muted-foreground text-xs">3</span>
      </div>
      <div className="divide-border divide-y">
        {OUTPUT.map((row) => (
          <div key={row.file} className="flex items-center gap-3 px-4 py-3.5">
            <GitPullRequest className="text-muted-foreground/50 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate font-mono text-[12.5px]">{row.file}</p>
              <p className="text-muted-foreground mt-0.5 text-[11px]">{row.meta}</p>
            </div>
            <span className="text-kortix-green shrink-0 font-mono text-[11px]">+{row.add}</span>
            <span className="text-destructive shrink-0 font-mono text-[11px]">-{row.del}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── 04 · approval ──────────────────────────────────────────────────────── */

const DIFF = [
  { sign: '+', text: '# Acme — Q3 renewal' },
  { sign: '+', text: 'Seats: 120 → 165 (+37%)' },
  { sign: '+', text: 'ARR: $148,000 → $203,500' },
  { sign: '+', text: 'Risk: SSO rollout blocked on SCIM mapping' },
  { sign: '-', text: 'TODO: pull the numbers' },
];

function ApprovalPanel() {
  return (
    <Card className="relative">
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <GitMerge className="text-kortix-green size-3.5" />
        <span className="text-foreground font-mono text-[12.5px]">sales/renewals/acme.md</span>
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
      <span className="bg-kortix-blue absolute -right-2 -bottom-3 rounded-full px-3 py-1 text-[12px] font-medium text-white">
        You
      </span>
    </Card>
  );
}
