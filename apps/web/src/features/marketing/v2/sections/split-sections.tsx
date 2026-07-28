'use client';

import { Icon } from '@/features/icon/icon';
import { MANY_AGENTS, NOT_PLATFORM, SANDBOX } from '@/features/marketing/v2/content';
import { Frame, Heading, Lead, LedeBullet, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ChevronsUpDown, GitBranch, Search } from 'lucide-react';
import type { ReactNode } from 'react';

/** Copy on one side, a product still on the other. */
function Split({
  id,
  heading,
  description,
  bullets,
  visual,
  reversed,
  className,
}: {
  id: string;
  heading: string[];
  description: string;
  bullets: { lede: string; rest: string }[];
  visual: ReactNode;
  reversed?: boolean;
  className?: string;
}) {
  return (
    <Section id={id} className={className}>
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className={cn(reversed && 'lg:order-2')}>
          <Heading lines={heading} />
          <Lead className="mt-6">{description}</Lead>
          <div className="mt-10">
            {bullets.map((b) => (
              <LedeBullet key={b.lede} lede={b.lede} rest={b.rest} />
            ))}
          </div>
        </div>
        <Frame className={cn('aspect-[4/3]', reversed && 'lg:order-1')}>{visual}</Frame>
      </div>
    </Section>
  );
}

const HARNESS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'Claude Code': Icon.Claude,
  Codex: Icon.Codex,
  OpenCode: Icon.OpenCode,
  Gemini: Icon.Gemini,
  Cursor: Icon.Cursor,
};

/* ── agents shouldn't become your platform ───────────────────────────────── */

export function NotPlatformSection() {
  return (
    <Split
      id="automations"
      heading={NOT_PLATFORM.heading}
      description={NOT_PLATFORM.description}
      bullets={NOT_PLATFORM.bullets}
      visual={<HarnessPicker />}
    />
  );
}

function HarnessPicker() {
  return (
    <div className="bg-muted/40 absolute inset-0 flex items-center justify-center p-6 sm:p-8">
      <div className="relative w-full max-w-[19rem]">
        <div className="border-border bg-background mx-auto flex w-fit items-center gap-2 rounded-sm border px-3.5 py-1.5 text-[13px] shadow-xs">
          <Icon.Claude className="size-3.5" />
          <span className="text-foreground font-medium">Multiple agents</span>
          <ChevronsUpDown className="text-muted-foreground size-3" />
        </div>

        <div className="border-border bg-background mt-3 overflow-hidden rounded-sm border shadow-md">
          <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs">
            <Search className="size-3" />
            Filter agents…
          </div>
          <ul className="p-1">
            {NOT_PLATFORM.harnesses.map((name, i) => {
              const Glyph = HARNESS_ICONS[name];
              return (
                <li
                  key={name}
                  className={cn(
                    'flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs',
                    i === 3 ? 'bg-accent text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {Glyph ? <Glyph className="size-3" /> : <span className="size-3" />}
                  {name}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-border bg-background absolute -right-10 bottom-4 hidden w-36 overflow-hidden rounded-sm border p-1 shadow-md sm:block">
          <p className="text-muted-foreground px-2 py-1.5 text-xs">Filter models…</p>
          {NOT_PLATFORM.models.map((model) => (
            <p key={model} className="text-muted-foreground px-2 py-1 text-xs">
              {model}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── cloud dev environments ──────────────────────────────────────────────── */

export function SandboxSection() {
  return (
    <Split
      id="sandboxes"
      reversed
      className="bg-muted/40 border-border border-y"
      heading={SANDBOX.heading}
      description={SANDBOX.description}
      bullets={SANDBOX.bullets}
      visual={<SessionsList />}
    />
  );
}

function SessionsList() {
  return (
    <div className="bg-background absolute inset-0 flex items-center p-6 sm:p-8">
      <div className="border-border bg-background w-full overflow-hidden rounded-sm border shadow-sm">
        <p className="border-border text-muted-foreground border-b px-4 py-3 text-[13px]">
          Sessions
        </p>
        <ul>
          {SANDBOX.sessions.map((session, i) => (
            <li
              key={session.title}
              className={cn('px-4 py-3', i === 0 && 'bg-accent')}
              style={{ opacity: 1 - i * 0.15 }}
            >
              <p className="text-foreground truncate text-[13px]">{session.title}</p>
              <p className="text-muted-foreground mt-1 flex items-center gap-2 text-[11px]">
                {session.who}
                {session.running && (
                  <span className="text-kortix-blue flex items-center gap-1 font-medium">
                    <span className="bg-kortix-blue size-1.5 rounded-full" />
                    Running…
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── the future isn't one agent ──────────────────────────────────────────── */

export function ManyAgentsSection() {
  return (
    <Split
      id="many-agents"
      heading={MANY_AGENTS.heading}
      description={MANY_AGENTS.description}
      bullets={MANY_AGENTS.bullets}
      visual={<ParallelRuns />}
    />
  );
}

const RUNS = [
  { title: 'Remove exposed API keys from audit log messages', harness: 'Claude Code' },
  { title: 'Backfill the missing firmographics for Q3', harness: 'Codex' },
  { title: 'Migrate session tokens to the new scheduler', harness: 'OpenCode' },
];

function ParallelRuns() {
  return (
    <div className="bg-muted/40 absolute inset-0 flex flex-col justify-center gap-3 p-6 sm:p-8">
      {RUNS.map((run, i) => {
        const Glyph = HARNESS_ICONS[run.harness];
        return (
          <div
            key={run.title}
            className="border-border bg-background rounded-sm border p-4 shadow-xs"
            style={{ marginLeft: `${i * 1.25}rem`, opacity: 1 - i * 0.18 }}
          >
            <p className="text-foreground truncate text-[13px] font-medium">{run.title}</p>
            <div className="mt-3 flex items-center gap-2">
              <span className="border-border bg-card text-muted-foreground flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px]">
                {Glyph ? <Glyph className="size-3" /> : null}
                {run.harness}
              </span>
              <GitBranch className="text-kortix-green size-3.5" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
