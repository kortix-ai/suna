'use client';

import { cn } from '@kortix/ui';
import Link from '@/components/site-link';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { UsersThreeIcon } from '@phosphor-icons/react/dist/ssr';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import {
  accessProject,
  accessRows,
  auditRows,
  auditStream,
  groupRows,
  heldCall,
  hero,
  ssoRows,
  steps,
  type StepId,
} from './content';
import { Status, Window } from '@/features/marketing/enterprise/parts';

/*
 * The /compliance hero, in the home page's SandBandHero layout: the two-tone
 * title and one sentence on white, then a band with one product window, the
 * admin view of the fictional Arcadia. The step strip above it walks the
 * path an admin sets up: sign-in, directory, access, approvals, audit. It
 * advances every 4 s until a reader picks a step (never with reduced motion).
 */

const STEP_MS = 4000;

const row = 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6';

const frame = 'flex-none';

function SsoStep() {
  return (
    <Window title="Arcadia · Identity" className={frame}>
      <ul className="flex flex-col divide-y">
        {ssoRows.map((r) => (
          <li key={r.k} className={row}>
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground text-sm font-medium">{r.k}</span>
              <span className="text-muted-foreground text-sm">{r.v}</span>
            </div>
            <Status>{r.status}</Status>
          </li>
        ))}
      </ul>
    </Window>
  );
}

function DirectoryStep() {
  return (
    <Window title="Arcadia · Groups" className={frame}>
      <ul className="flex flex-col divide-y">
        {groupRows.map((r) => (
          <li key={r.k} className={row}>
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                <UsersThreeIcon className="size-4.5" aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-foreground text-sm font-medium">{r.k}</span>
                <span className="text-muted-foreground text-sm">{r.v}</span>
              </div>
            </div>
            <span className="text-muted-foreground rounded-sm border px-2 py-0.5 text-xs">From your directory</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground border-t px-4 py-3 text-sm sm:px-6">
        Removed in your directory, removed here.
      </p>
    </Window>
  );
}

function AccessStep() {
  return (
    <Window title={`Arcadia · ${accessProject} → Access`} className={frame}>
      <ul className="flex flex-col divide-y">
        {accessRows.map((r) => (
          <li key={r.who} className={row}>
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground text-sm font-medium">
                {r.who}
                <span className="text-muted-foreground font-normal"> · {r.kind}</span>
              </span>
              <span className="text-muted-foreground text-sm">{r.agents}</span>
            </div>
            <span className="text-foreground rounded-sm border px-2 py-0.5 text-sm">{r.role}</span>
          </li>
        ))}
      </ul>
    </Window>
  );
}

function ApprovalsStep() {
  return (
    <Window title="Arcadia · Review" className={frame}>
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <code className="text-foreground font-mono text-sm font-medium">{heldCall.call}</code>
            <span className="text-muted-foreground text-sm">Asked by {heldCall.agent}</span>
          </div>
          <Status tone="wait">Ask</Status>
        </div>
        <dl className="bg-muted/50 flex flex-col gap-1 rounded-md px-3 py-2 font-mono text-xs">
          {heldCall.args.map((a) => (
            <div key={a.k} className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{a.k}</dt>
              <dd className="text-foreground break-all">{a.v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-muted-foreground text-sm">
            {heldCall.who} · {heldCall.expires}
          </span>
          {/* A picture of the controls, not controls: nothing to click. */}
          <span aria-hidden className="flex gap-2">
            <span className="text-foreground rounded-md border px-3 py-1 text-sm">Deny</span>
            <span className="bg-foreground text-background rounded-md px-3 py-1 text-sm">Approve</span>
          </span>
        </div>
      </div>
    </Window>
  );
}

function AuditStep() {
  return (
    <Window title="Arcadia · Audit log" className={frame}>
      <ul className="flex flex-col divide-y">
        {auditRows.map((r) => (
          <li key={`${r.t}-${r.action}`} className="flex items-start gap-4 px-4 py-3 sm:px-6">
            <span className="text-muted-foreground w-10 shrink-0 font-mono text-xs leading-5 tabular-nums">{r.t}</span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-foreground text-sm">{r.who}</span>
              <code className="text-muted-foreground font-mono text-xs break-all">{r.action}</code>
            </div>
            <Status tone={r.result === 'denied' ? 'no' : 'ok'}>{r.result}</Status>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground flex items-center gap-2 border-t px-4 py-3 text-sm sm:px-6">
        <span aria-hidden className="bg-kortix-green size-1.5 shrink-0 rounded-full" />
        {auditStream}
      </p>
    </Window>
  );
}

const STEP_VIEWS: Record<StepId, () => ReactNode> = {
  sso: () => <SsoStep />,
  directory: () => <DirectoryStep />,
  access: () => <AccessStep />,
  approvals: () => <ApprovalsStep />,
  audit: () => <AuditStep />,
};

function Walkthrough() {
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
        aria-label="How an admin sets up the controls"
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
            id={`compliance-walk-${s.id}`}
            aria-controls="compliance-walk-panel"
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
        id="compliance-walk-panel"
        aria-labelledby={`compliance-walk-${step.id}`}
        className="flex w-full max-w-3xl flex-col gap-6"
      >
        {/* A fixed height, set by the tallest step, keeps the band still while the steps change. */}
        <div key={step.id} className={cn('flex min-h-90 flex-col justify-center', fade)}>
          {STEP_VIEWS[step.id]()}
        </div>
        <p key={`line-${step.id}`} className={cn('text-foreground px-4 text-center text-base text-balance', fade)}>
          {step.line}
        </p>
      </div>
    </div>
  );
}

export function ComplianceHero() {
  const openDemo = useRequestDemo();
  return (
    <section id="hero" className="relative">
      <div className="relative flex flex-col gap-7.5 px-8 pt-32 pb-18 lg:px-28 lg:pt-40">
        <div className="flex flex-col gap-4 lg:gap-5">
          <h1 className="max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
            <span className="text-foreground block">{hero.title}</span>
            <span className="text-muted-foreground block">{hero.titleMuted}</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">{hero.sub}</p>
        </div>
        <div className="flex flex-wrap gap-2.5 pt-2">
          <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
            <Link href="/pricing">Compare plans</Link>
          </MarketingButton>
          <MarketingButton size="md" className="hit-area-y-1" onClick={() => openDemo({ source: 'compliance-hero' })}>
            Talk to sales
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
